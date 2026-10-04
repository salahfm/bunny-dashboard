/**
 * The Cloudflare quick tunnel that makes this dashboard reachable from outside.
 *
 * Why it exists: Bunny's `fetch` endpoint pulls a URL from Bunny's own network,
 * which means `http://127.0.0.1:4747` is not something it can be pointed at. The
 * tunnel gives the local relay a public `https://<name>.trycloudflare.com` address
 * so the backend can hand Bunny the stream it just downloaded — download on this
 * side, upload on Bunny's, at the same time. When the tunnel is not available the
 * job falls back to uploading the bytes itself.
 *
 * `cloudflared` is fetched into `.tools/` on first use when it is not installed,
 * because a dashboard that needs a manual binary install for its one-click flow
 * is not one-click.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type TunnelState = 'stopped' | 'starting' | 'running' | 'unavailable' | 'error';

export interface TunnelStatus {
  /** Whether the operator wants the tunnel used at all (`SOURCE_TUNNEL=0` turns it off). */
  enabled: boolean;
  state: TunnelState;
  /** The public base URL Bunny will be pointed at. */
  url: string | null;
  /** Whether the URL came from the environment rather than a process we started. */
  external: boolean;
  detail: string | null;
  restarts: number;
  since: string | null;
}

export interface TunnelOptions {
  /** Project root — `.tools/` lives here. */
  root: string;
  /** The local port the tunnel points at. */
  port: number;
  enabled?: boolean;
  /** Set to skip the automatic download (`SOURCE_TUNNEL_DOWNLOAD=0`). */
  allowDownload?: boolean;
  /** An externally managed tunnel URL; when set, nothing is spawned. */
  externalUrl?: string;
  binaryPath?: string;
  log?: (message: string) => void;
}

/** The public URL cloudflared prints once its quick tunnel is up. */
export function parseTunnelUrl(line: string): string | null {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
  return match ? match[0].toLowerCase() : null;
}

const READY_TIMEOUT_MS = 45_000;
const MAX_RESTARTS = 3;
const MAX_LOG_LINES = 200;

function downloadUrl(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
  if (process.platform === 'linux') return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  if (process.platform === 'darwin') return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  return null;
}

export class TunnelManager {
  private options: Required<Pick<TunnelOptions, 'root' | 'port' | 'enabled' | 'allowDownload'>> & TunnelOptions;
  private child?: ChildProcess;
  private logLines: string[] = [];
  private state: TunnelState = 'stopped';
  private url: string | null = null;
  private detail: string | null = null;
  private since: string | null = null;
  private restarts = 0;
  private starting?: Promise<TunnelStatus>;
  private stopping = false;

  constructor(options: TunnelOptions) {
    this.options = {
      enabled: options.enabled !== false,
      allowDownload: options.allowDownload !== false,
      ...options,
      root: options.root,
      port: options.port,
    };
    if (options.externalUrl) {
      this.url = normalizeBase(options.externalUrl);
      this.state = 'running';
      this.since = new Date().toISOString();
      this.detail = 'using the tunnel URL from the environment';
    }
  }

  status(): TunnelStatus {
    return {
      enabled: this.options.enabled,
      state: this.state,
      url: this.url,
      external: Boolean(this.options.externalUrl),
      detail: this.detail,
      restarts: this.restarts,
      since: this.since,
    };
  }

  logs(limit = 40): string[] {
    return this.logLines.slice(-limit);
  }

  /** The public base URL, starting the tunnel if it is not up yet. */
  async ensure(): Promise<string | null> {
    if (this.url) return this.url;
    if (!this.options.enabled) return null;
    const status = await this.start();
    return status.url;
  }

  private binaryPath(): string {
    if (this.options.binaryPath) return this.options.binaryPath;
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(this.options.root, '.tools', 'cloudflared', name);
  }

  /**
   * Resolves the cloudflared to run, downloading the official release when the
   * machine does not have one. A download failure is reported, never fatal: the
   * pipeline falls back to uploading the bytes itself.
   */
  private async ensureBinary(): Promise<string | null> {
    // An explicitly configured binary is used as given, even if it is missing:
    // the operator said where cloudflared is, and a spawn failure says more than
    // silently downloading a different one would.
    if (this.options.binaryPath) {
      this.append(`using the configured cloudflared: ${this.options.binaryPath}`);
      return this.options.binaryPath;
    }

    const target = this.binaryPath();
    if (fs.existsSync(target)) return target;

    const fromPath = findOnPath(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fromPath) {
      this.append(`using cloudflared from PATH: ${fromPath}`);
      return fromPath;
    }

    if (!this.options.allowDownload) {
      this.detail = 'cloudflared is not installed and automatic download is off (set SOURCE_TUNNEL_DOWNLOAD=1)';
      return null;
    }
    const url = downloadUrl();
    if (!url) {
      this.detail = `no cloudflared build for ${process.platform}/${process.arch}`;
      return null;
    }

    this.append(`downloading cloudflared from ${url}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.download`;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (url.endsWith('.tgz')) {
        // The macOS build ships as a tarball; `tar` is present on every mac.
        fs.writeFileSync(temporary, buffer);
        const { execFileSync } = await import('node:child_process');
        execFileSync('tar', ['-xzf', temporary, '-C', path.dirname(target)], { stdio: 'ignore' });
        if (!fs.existsSync(target)) throw new Error('the archive did not contain cloudflared');
        fs.rmSync(temporary, { force: true });
      } else {
        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);
        if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
      }
      this.append(`cloudflared saved to ${target}`);
      return target;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      this.detail = `could not download cloudflared: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  private append(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.logLines.push(text.length > 300 ? `${text.slice(0, 297)}…` : text);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    this.options.log?.(`[tunnel] ${text}`);
  }

  /** Starts (or returns the already running) quick tunnel. */
  async start(): Promise<TunnelStatus> {
    if (this.url) return this.status();
    if (!this.options.enabled) {
      this.state = 'unavailable';
      this.detail = 'the tunnel is disabled (SOURCE_TUNNEL=0)';
      return this.status();
    }
    if (this.starting) return this.starting;

    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch(): Promise<TunnelStatus> {
    this.state = 'starting';
    this.detail = null;
    const binary = await this.ensureBinary();
    if (!binary) {
      this.state = 'unavailable';
      return this.status();
    }

    const args = ['tunnel', '--url', `http://127.0.0.1:${this.options.port}`, '--no-autoupdate', '--loglevel', 'info'];
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    return await new Promise<TunnelStatus>((resolve) => {
      let settled = false;
      const finish = (status: TunnelStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status);
      };

      const onLine = (line: string) => {
        this.append(line);
        const publicUrl = parseTunnelUrl(line);
        if (publicUrl && !this.url) {
          this.url = normalizeBase(publicUrl);
          this.state = 'running';
          this.since = new Date().toISOString();
          this.detail = null;
          finish(this.status());
        }
      };
      child.stdout?.on('data', (chunk: string) => chunk.split(/\r?\n/).forEach(onLine));
      child.stderr?.on('data', (chunk: string) => chunk.split(/\r?\n/).forEach(onLine));

      child.on('error', (error) => {
        this.state = 'error';
        this.detail = `cloudflared could not start: ${error.message}`;
        finish(this.status());
      });

      child.on('exit', (code) => {
        this.child = undefined;
        const wasRunning = this.url !== null;
        this.url = null;
        if (this.stopping) {
          this.state = 'stopped';
          finish(this.status());
          return;
        }
        this.state = 'error';
        this.detail = `cloudflared exited (code ${code ?? 'unknown'})`;
        this.append(this.detail);
        finish(this.status());
        if (wasRunning) void this.autoRestart();
      });

      const timer = setTimeout(() => {
        this.state = 'error';
        this.detail = `cloudflared did not report a public URL within ${Math.round(READY_TIMEOUT_MS / 1000)}s`;
        finish(this.status());
      }, READY_TIMEOUT_MS);
    });
  }

  private async autoRestart(): Promise<void> {
    if (this.stopping || !this.options.enabled) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.append(`giving up after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    this.append(`restarting the tunnel (attempt ${this.restarts})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * this.restarts));
    await this.start().catch(() => undefined);
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.url = null;
    this.state = 'stopped';
    this.detail = 'stopped';
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** A tiny `which`, so an installed cloudflared can be preferred over a download. */
function findOnPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
