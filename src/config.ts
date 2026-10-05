import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampChunkBytes } from './tus';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HARD_MAX_ACCOUNTS = 30;
export const HARD_MAX_CONCURRENCY = 10;
export const DEFAULT_MAX_ACCOUNTS = 30;
export const DEFAULT_CONCURRENCY = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB per file, streamed straight to disk

/** `tus` survives dropped connections; `put` is the single-request fallback. */
export type UploadMode = 'tus' | 'put';

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  dataDir: string;
  uploadsDir: string;
  dbPath: string;
  secretPath: string;
  publicDir: string;
  mock: boolean;
  uploadMode: UploadMode;
  tusChunkBytes: number;
  /** Default for the watched folder; the setting in the dashboard wins once set. */
  watchDir?: string;
  watchIntervalMs: number;
  watchMinAgeMs: number;
  maxAccounts: number;
  perAccountConcurrency: number;
  tickIntervalMs: number;
  pollIntervalMs: number;
  maxPollsPerJob: number;
  /** Parallel segment downloads for a scraped stream. */
  streamConcurrency: number;
  /** Whether the dashboard may start a Cloudflare quick tunnel for Bunny to pull from. */
  tunnelEnabled: boolean;
  /** Whether a missing cloudflared may be downloaded into `.tools/`. */
  tunnelDownload: boolean;
  /** An externally managed tunnel URL, used instead of spawning cloudflared. */
  tunnelPublicUrl?: string;
  cloudflaredPath?: string;
  /** Per-attempt ceiling for outbound control-plane calls (Bunny API, playlists). */
  networkTimeoutMs: number;
  /** Extra attempts after the first, for a flaky network path. */
  networkRetries: number;
  /** Login for the dashboard itself; absent when no password is configured. */
  dashboardUser?: string;
  dashboardPassword?: string;
  /** Smallest gap between two scrape requests to the same host. */
  scrapeMinIntervalMs: number;
  /** Base cooldown after a host refuses (403/429/5xx or a bot challenge). */
  scrapeCooldownMs: number;
  /**
   * Rewrite requests aimed at these hosts through a replacement base first.
   * The intended use is a bunny.net pull zone whose origin is the host: the
   * request then leaves from Bunny's edge instead of this machine.
   */
  scrapeEgress: Record<string, string>;
  /** Carry a stream's subtitle tracks into Bunny as caption tracks. */
  subtitleUpload: boolean;
  /** The language a title should end up with; when it is missing, one is translated. */
  subtitleTargetLanguage: string;
  /**
   * The text translator used to fill in the target language.
   *
   * Absent means no translation happens at all — the dashboard only carries the
   * subtitle tracks the stream already had. Configure it and an English track
   * becomes Arabic whenever a title arrives without one.
   */
  translator?: {
    provider: 'openai' | 'deepl';
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
}

export function clampConcurrency(value: unknown, fallback = DEFAULT_CONCURRENCY): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(HARD_MAX_CONCURRENCY, Math.floor(n)));
}

export function clampMaxAccounts(value: unknown, fallback = DEFAULT_MAX_ACCOUNTS): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(HARD_MAX_ACCOUNTS, Math.floor(n)));
}

/** Milliseconds from the environment, falling back when it is missing or nonsense. */
export function clampIntervalMs(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/**
 * `SCRAPER_EGRESS` — `host=base` pairs, comma separated, e.g.
 * `vidfast.vc=https://vz-abc.b-cdn.net,movish.to=https://vz-def.b-cdn.net`.
 *
 * A host with no entry is contacted directly. The base must be absolute; a
 * malformed pair is ignored rather than silently rewriting requests elsewhere.
 */
export function parseEgressMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'string' || !value.trim()) return out;
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const host = trimmed.slice(0, separator).trim().toLowerCase();
    const base = trimmed.slice(separator + 1).trim().replace(/\/+$/, '');
    if (!host || !/^https?:\/\//i.test(base)) continue;
    out[host] = base;
  }
  return out;
}

/**
 * `SUBTITLE_TRANSLATOR` plus its key — the text engine that makes an Arabic
 * track when a title has none. Only `openai` (any OpenAI-compatible endpoint)
 * and `deepl` are understood; anything else, or a missing key, disables it.
 */
export function parseTranslator(env: NodeJS.ProcessEnv): AppConfig['translator'] {
  const provider = (env.SUBTITLE_TRANSLATOR ?? '').trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'deepl') return undefined;
  const apiKey = (env.SUBTITLE_TRANSLATOR_KEY ?? '').trim();
  if (!apiKey) return undefined;
  return {
    provider,
    apiKey,
    ...(env.SUBTITLE_TRANSLATOR_URL ? { baseUrl: env.SUBTITLE_TRANSLATOR_URL.trim() } : {}),
    ...(env.SUBTITLE_TRANSLATOR_MODEL ? { model: env.SUBTITLE_TRANSLATOR_MODEL.trim() } : {}),
  };
}

export function parseUploadMode(value: unknown, fallback: UploadMode = 'tus'): UploadMode {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (mode === 'tus' || mode === 'put') return mode;
  return fallback;
}

function loadEnvFile(root: string, env: NodeJS.ProcessEnv): void {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): AppConfig {
  const root = path.resolve(here, '..');
  loadEnvFile(root, env);
  const mock = argv.includes('--mock') || env.MOCK_PROVIDERS === '1' || env.MOCK_PROVIDERS === 'true';
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const port = Number(env.PORT ?? 4747);
  return {
    root,
    port: Number.isFinite(port) && port > 0 ? port : 4747,
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    uploadsDir,
    dbPath: path.join(dataDir, 'db.json'),
    secretPath: path.join(dataDir, '.secret'),
    publicDir: path.join(root, 'public'),
    mock,
    uploadMode: parseUploadMode(env.UPLOAD_MODE),
    tusChunkBytes: clampChunkBytes(env.TUS_CHUNK_BYTES),
    ...(env.WATCH_DIR ? { watchDir: env.WATCH_DIR } : {}),
    watchIntervalMs: clampIntervalMs(env.WATCH_INTERVAL_MS, 15_000, 1_000),
    watchMinAgeMs: clampIntervalMs(env.WATCH_MIN_AGE_MS, 30_000, 0),
    maxAccounts: clampMaxAccounts(env.MAX_ACCOUNTS),
    perAccountConcurrency: clampConcurrency(env.PER_ACCOUNT_CONCURRENCY),
    tickIntervalMs: Number(env.TICK_INTERVAL_MS ?? 1000),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 10_000),
    maxPollsPerJob: Number(env.MAX_POLLS_PER_JOB ?? 2160),
    streamConcurrency: clampConcurrency(env.STREAM_CONCURRENCY, 4),
    tunnelEnabled: envFlag(env.SOURCE_TUNNEL, true),
    tunnelDownload: envFlag(env.SOURCE_TUNNEL_DOWNLOAD, true),
    ...(env.TUNNEL_PUBLIC_URL ? { tunnelPublicUrl: env.TUNNEL_PUBLIC_URL.trim() } : {}),
    ...(env.CLOUDFLARED ? { cloudflaredPath: env.CLOUDFLARED.trim() } : {}),
    networkTimeoutMs: clampIntervalMs(env.NETWORK_TIMEOUT_MS, 30_000, 1_000),
    networkRetries: Math.max(0, Math.min(8, Math.floor(clampIntervalMs(env.NETWORK_RETRIES, 3, 0)))),
    // A password turns the login on; without one the dashboard is open, which is
    // why the startup log nags when it is listening beyond localhost.
    ...(env.DASHBOARD_PASSWORD
      ? { dashboardPassword: env.DASHBOARD_PASSWORD, dashboardUser: env.DASHBOARD_USER?.trim() || 'index' }
      : {}),
    scrapeMinIntervalMs: clampIntervalMs(env.SCRAPER_MIN_INTERVAL_MS, 350, 0),
    scrapeCooldownMs: clampIntervalMs(env.SCRAPER_COOLDOWN_MS, 60_000, 1_000),
    scrapeEgress: parseEgressMap(env.SCRAPER_EGRESS),
    subtitleUpload: envFlag(env.SUBTITLES, true),
    subtitleTargetLanguage: (env.SUBTITLE_TARGET_LANG ?? 'ar').trim().toLowerCase() || 'ar',
    ...(parseTranslator(env) ? { translator: parseTranslator(env) } : {}),
  };
}

/** `KEY=0`, `false`, `no` and `off` all turn a switch off; anything else leaves it on. */
function envFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  return fallback;
}
