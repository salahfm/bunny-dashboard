/**
 * The relay: what Bunny fetches from.
 *
 * A source URL is usually locked to the IP and referer of whoever resolved it, so
 * Bunny cannot pull it directly — and pushing the bytes ourselves through the
 * upload API loses the "Bunny downloads it" half of the flow. This serves the
 * very same spool file the downloader is filling, publicly (through the tunnel),
 * in the two shapes a remote fetcher understands:
 *
 *   /relay/<token>/master.m3u8   a one-variant master playlist
 *   /relay/<token>/playlist.m3u8 the media playlist, segments rewritten to us
 *   /relay/<token>/seg/<n>.<ext> one segment, read straight from the spool
 *   /relay/<token>/stream.<ext>  the whole file, with Content-Length and ranges
 *
 * Serving a segment is a read from the spool — no second fetch of that segment,
 * and no second copy on disk. The byte spans come from the spool itself (what the
 * downloader actually appended), not from the measured playlist sizes: an
 * encrypted source is decrypted on the way in, and AES padding makes the real
 * stream shorter than the ciphertext the sizing step measured. A Content-Length
 * taken from that plan would leave Bunny waiting for bytes that never come.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamSpool } from './hls';

export interface RelaySegment {
  duration: number;
  offset: number;
  bytes: number;
}

export interface RelayTarget {
  jobId: string;
  /** Shown in Bunny's job row, e.g. `Movy 1080p`. */
  label: string;
  spool: StreamSpool;
  segments: RelaySegment[];
  totalBytes: number;
  extension: 'ts' | 'mp4';
  contentType: string;
  /** Carried into the one-variant master playlist; defaulted when unknown. */
  bandwidth?: number;
}

interface RelayEntry extends RelayTarget {
  token: string;
  createdAt: number;
  /** Last time Bunny (or anyone) read from this relay. */
  lastAccess: number;
}

export class RelayHub {
  private entries = new Map<string, RelayEntry>();
  /** The path the hub is mounted under; a leading segment with this name is skipped. */
  private basePath: string;

  constructor(options: { basePath?: string } = {}) {
    this.basePath = (options.basePath ?? 'relay').replace(/^\/+|\/+$/g, '');
  }

  /** Publishes a target and returns the token it can be reached under. */
  register(target: RelayTarget): string {
    const token = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    this.entries.set(token, { ...target, token, createdAt: now, lastAccess: now });
    return token;
  }

  /**
   * Unpublishes a target and deletes its spool file.
   *
   * Every path that finishes with a stream job goes through here — the direct
   * transport when its upload lands, the tunnel transport when Bunny is done
   * pulling, and cancellation. Deleting the spool in the same breath is why a
   * cancelled job cannot leave a gigabyte of half a film in `data/uploads`.
   */
  release(token: string | undefined): void {
    if (!token) return;
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    entry.spool.remove();
  }

  /** Relays nobody has read for a while (a Bunny fetch that died, say). */
  sweepIdle(maxIdleMs = 30 * 60_000): string[] {
    const now = Date.now();
    const released: string[] = [];
    for (const [token, entry] of [...this.entries]) {
      if (now - entry.lastAccess < maxIdleMs) continue;
      this.entries.delete(token);
      entry.spool.remove();
      released.push(entry.jobId);
    }
    return released;
  }

  get(token: string): RelayEntry | undefined {
    return this.entries.get(token);
  }

  /** `GET /relay/<token>/<file>` — anything else is a 404. */
  handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    // Mounted as `/relay` Express strips that prefix; a plain HTTP server keeps
    // it. Both are accepted, so the hub can be served either way.
    if (parts[0] === this.basePath) parts.shift();
    const token = parts[0] ?? '';
    const file = parts[1] ?? '';
    const entry = this.entries.get(token);
    if (!entry) {
      res.statusCode = 404;
      res.end('unknown relay target');
      return;
    }
    entry.lastAccess = Date.now();

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }

    try {
      if (file === 'master.m3u8') return this.sendMaster(entry, req, res);
      if (file === 'playlist.m3u8') return this.sendPlaylist(entry, req, res);
      if (file === `stream.${entry.extension}`) return this.sendFile(entry, req, res);
      const segment = /^seg\/(\d+)\.(ts|mp4)$/.exec(parts.slice(1).join('/'));
      if (segment) {
        void this.sendSegment(entry, Number(segment[1]), req, res).catch((error) => {
          if (!res.headersSent) res.statusCode = 502;
          res.end(error instanceof Error ? error.message : 'relay failure');
        });
        return;
      }
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(error instanceof Error ? error.message : 'relay failure');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  };

  private sendMaster(entry: RelayEntry, req: IncomingMessage, res: ServerResponse): void {
    const bandwidth = entry.bandwidth && entry.bandwidth > 0 ? Math.round(entry.bandwidth) : 8_000_000;
    const body = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},NAME="${entry.label}"`,
      'playlist.m3u8',
      '',
    ].join('\n');
    this.sendText(req, res, body);
  }

  private sendPlaylist(entry: RelayEntry, req: IncomingMessage, res: ServerResponse): void {
    const durations = entry.segments.map((segment) => segment.duration);
    const target = Math.max(1, Math.ceil(Math.max(...durations, 1)));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${target}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    entry.segments.forEach((segment, index) => {
      const duration = segment.duration > 0 ? segment.duration : target;
      lines.push(`#EXTINF:${duration.toFixed(3)},`);
      lines.push(`seg/${index}.${entry.extension}`);
    });
    lines.push('#EXT-X-ENDLIST');
    this.sendText(req, res, `${lines.join('\n')}\n`);
  }

  /** A playlist is short and known; the file and segment paths stream from disk. */
  private sendText(req: IncomingMessage, res: ServerResponse, body: string): void {
    const payload = Buffer.from(body, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Length', String(payload.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  /**
   * One segment, at the length it actually has (not the length it was measured
   * to have). A segment the downloader has not reached yet parks the request
   * until it arrives, which is what lets Bunny pull while the download runs.
   */
  private async sendSegment(entry: RelayEntry, index: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const planned = entry.segments[index];
    if (!planned) {
      res.statusCode = 404;
      res.end('no such segment');
      return;
    }
    const actual = req.method === 'HEAD' ? entry.spool.segments[index] : await entry.spool.waitForSegment(index).catch(() => undefined);
    if (!actual) {
      res.statusCode = 502;
      res.end('the download did not produce that segment');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Content-Length', String(actual.bytes));
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    void this.pump(entry, actual.offset, actual.offset + actual.bytes, res);
  }

  private sendFile(entry: RelayEntry, req: IncomingMessage, res: ServerResponse): void {
    // A finished download knows its real size; while it runs, the measured plan
    // is the only length that can be declared up front.
    const total = entry.spool.done ? entry.spool.bytes : entry.totalBytes;
    const range = parseRange(req.headers.range as string | undefined, total);
    const start = range?.start ?? 0;
    const end = range?.end ?? total;
    res.statusCode = range ? 206 : 200;
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(Math.max(0, end - start)));
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    void this.pump(entry, start, end, res);
  }

  /** Copies `[start, end)` out of the spool, waiting for bytes still arriving. */
  private async pump(entry: RelayEntry, start: number, end: number, res: ServerResponse): Promise<void> {
    const chunkBytes = 256 * 1024;
    try {
      let position = start;
      while (position < end) {
        const wanted = Math.min(chunkBytes, end - position);
        const buffer = await entry.spool.read(position, wanted);
        if (!buffer.length) break;
        position += buffer.length;
        if (!res.write(buffer)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
    } catch (error) {
      // The response is already open, so the only honest thing left is to break
      // the connection: a truncated body becomes a failed fetch, not silent bytes.
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}

export function parseRange(header: string | undefined, total: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return undefined;
  let start = hasStart ? Number(match[1]) : total - Number(match[2]);
  let end = hasEnd ? Number(match[2]) + 1 : total;
  start = Math.max(0, Math.min(start, Math.max(0, total - 1)));
  end = Math.max(start, Math.min(end, total));
  return { start, end };
}

/** Absolute URL of the one file Bunny should fetch, for this relay target. */
export function relayStreamUrl(publicBase: string, token: string, extension: 'ts' | 'mp4'): string {
  return `${publicBase.replace(/\/+$/, '')}/relay/${token}/stream.${extension}`;
}

export function relayPlaylistUrl(publicBase: string, token: string): string {
  return `${publicBase.replace(/\/+$/, '')}/relay/${token}/playlist.m3u8`;
}

export function relayMasterUrl(publicBase: string, token: string): string {
  return `${publicBase.replace(/\/+$/, '')}/relay/${token}/master.m3u8`;
}

/** Removes a spool file that no job refers to any more. */
export function dropSpoolFile(path: string | undefined): void {
  if (!path) return;
  try {
    fs.rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}
