/**
 * HLS: master playlists → a real quality ladder, media playlists → segments, and
 * a downloader that writes them to a growing spool file in order.
 *
 * The spool is what makes the rest of the pipeline simple: the uploader (TUS or
 * the tunnel relay) reads from it while the downloader is still appending, so
 * "download and upload at the same time" is one file being written at one end and
 * read at the other. Byte ranges, AES-128 keys and fMP4 init segments are all
 * handled here, because a source that uses them is not a source to give up on.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchWithPolicy } from './net';

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Attempts after the first (playlists and sizing retry; segments retry upstream). */
  retries?: number;
}

/** The providers' hint about the tier a manifest URL belongs to, when it has one. */
export interface HlsVariant {
  label: string;
  url: string;
  height?: number;
  bandwidth?: number;
}

export interface HlsKey {
  method: 'AES-128';
  url: string;
  iv?: Buffer;
}

export interface HlsSegment {
  url: string;
  duration: number;
  index: number;
  byteRange?: { length: number; offset: number };
  /** fMP4 init segment, prepended once before the first media segment. */
  initUrl?: string;
  key?: HlsKey;
  /** Declared size (from `#EXT-X-BYTERANGE`), when the manifest carries one. */
  declaredBytes?: number;
}

export interface MediaPlaylist {
  segments: HlsSegment[];
  endList: boolean;
  targetDuration: number;
}

export function heightLabel(height: number): string {
  if (height >= 2000) return '4K';
  if (height >= 1300) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 460) return '480p';
  if (height >= 340) return '360p';
  if (height >= 200) return '240p';
  return `${Math.round(height)}p`;
}

function parseHeight(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /(\d{2,5})x(\d{2,5})/.exec(raw);
  const value = match ? Number(match[2]) : Number(raw);
  return Number.isFinite(value) && value >= 120 && value <= 4320 ? value : undefined;
}

function attributeList(line: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // Values may be quoted and contain commas, so split on commas outside quotes.
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    attributes.set(key.toUpperCase(), value.replace(/^"|"$/g, '').trim());
  }
  return attributes;
}

/** `#EXT-X-STREAM-INF` variants, best first; empty for a media playlist. */
export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  if (!text || !/#EXT-X-STREAM-INF/i.test(text)) return [];

  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const attributes = attributeList(line.slice(line.indexOf(':') + 1));

    let uri = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = (lines[next] ?? '').trim();
      if (!candidate || candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;

    const height = parseHeight(attributes.get('RESOLUTION'));
    const bandwidth = Number(attributes.get('BANDWIDTH')) || undefined;
    const name = attributes.get('NAME') ?? attributes.get('VIDEO-RANGE') ?? '';
    const label = height ? heightLabel(height) : /^(4k|\d{3,4}p)$/i.test(name) ? name.toLowerCase() : 'Auto';
    const url = absolutize(uri, baseUrl);
    if (!url.startsWith('http') || seen.has(label)) continue;
    seen.add(label);
    variants.push({ label, url, height, bandwidth });
  }

  return variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
}

function absolutize(url: string, base: string): string {
  if (url.startsWith('http')) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function parseKey(line: string, baseUrl: string): HlsKey | undefined {
  const attributes = attributeList(line.slice(line.indexOf(':') + 1));
  const method = (attributes.get('METHOD') ?? '').toUpperCase();
  if (method !== 'AES-128') return undefined;
  const uri = attributes.get('URI');
  if (!uri) return undefined;
  const key: HlsKey = { method: 'AES-128', url: absolutize(uri, baseUrl) };
  const iv = attributes.get('IV');
  if (iv) {
    const hex = iv.replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) key.iv = Buffer.from(hex, 'hex');
  }
  return key;
}

function ivForSequence(key: HlsKey, sequence: number): Buffer {
  if (key.iv) return key.iv;
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence >>> 0, 12);
  return iv;
}

/** Segments of a media playlist, in order, with keys and byte ranges attached. */
export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  const targetDurationMatch = /^#EXT-X-TARGETDURATION:\s*([\d.]+)/im.exec(text);
  let endList = false;
  let initUrl: string | undefined;
  let key: HlsKey | undefined;
  let duration = 0;
  let sequence = 0;
  let pendingRange: { length: number; offset: number } | undefined;
  let lastEnd = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(line)) {
      sequence = Number(line.split(':')[1] ?? 0) || 0;
      continue;
    }
    if (/^#EXT-X-KEY:/i.test(line)) {
      key = parseKey(line, baseUrl);
      continue;
    }
    if (/^#EXT-X-MAP:/i.test(line)) {
      const attributes = attributeList(line.slice(line.indexOf(':') + 1));
      const uri = attributes.get('URI');
      if (uri) initUrl = absolutize(uri, baseUrl);
      continue;
    }
    if (/^#EXT-X-BYTERANGE:/i.test(line)) {
      const [lengthRaw, offsetRaw] = line.slice(line.indexOf(':') + 1).trim().split('@');
      const length = Number(lengthRaw);
      if (Number.isFinite(length) && length > 0) {
        const offset = offsetRaw !== undefined ? Number(offsetRaw) : lastEnd;
        pendingRange = { length: Math.floor(length), offset: Number.isFinite(offset) ? Math.floor(offset) : 0 };
      }
      continue;
    }
    if (/^#EXTINF:/i.test(line)) {
      duration = Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0;
      continue;
    }
    if (/^#EXT-X-ENDLIST/i.test(line)) {
      endList = true;
      continue;
    }
    if (line.startsWith('#')) continue;

    const url = absolutize(line, baseUrl);
    if (!url.startsWith('http')) continue;
    const segment: HlsSegment = { url, duration, index: segments.length };
    if (initUrl) segment.initUrl = initUrl;
    if (key) segment.key = { ...key, iv: ivForSequence(key, sequence + segments.length) };
    if (pendingRange) {
      segment.byteRange = pendingRange;
      segment.declaredBytes = pendingRange.length;
      lastEnd = pendingRange.offset + pendingRange.length;
      pendingRange = undefined;
    } else {
      lastEnd = 0;
    }
    segments.push(segment);
    duration = 0;
  }

  return { segments, endList, targetDuration: targetDurationMatch ? Number(targetDurationMatch[1]) : 0 };
}

export function hasMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF/i.test(text) && !/#EXTINF:/i.test(text);
}

export function looksLikePlaylist(text: string): boolean {
  return /#EXTM3U/i.test(text);
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

async function fetchWithTimeout(url: string, options: FetchOptions, accept?: string): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return fetchWithPolicy(
    url,
    {
      headers: {
        ...(options.headers ?? {}),
        ...(accept ? { Accept: accept } : {}),
        ...(options.headers?.Range ? { Range: options.headers.Range } : {}),
      },
      redirect: 'follow',
    },
    {
      timeoutMs,
      retries: options.retries ?? 2,
      backoffMs: 700,
      what: 'the stream host',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export async function fetchPlaylist(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithTimeout(url, options, 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*');
  if (!response.ok) throw new Error(`the playlist request failed (HTTP ${response.status})`);
  const text = await response.text();
  if (!looksLikePlaylist(text)) throw new Error('that URL did not answer an HLS playlist');
  return text;
}

/** A playlist fetched from the source, whichever of the two kinds it turned out to be. */
export interface ResolvedPlaylist {
  text: string;
  url: string;
  /** The tier label, when a master playlist had to be walked to reach it. */
  variantLabel?: string;
  variantHeight?: number;
  variants: HlsVariant[];
}

/**
 * Reads a URL that may be a master or a media playlist and returns the media
 * playlist, walking the ladder when it has to. `maxHeight` is the ceiling the
 * caller will accept (2160 by default, i.e. whatever the host has).
 */
export async function resolvePlaylist(
  url: string,
  options: FetchOptions & { maxHeight?: number } = {},
): Promise<ResolvedPlaylist> {
  const first = await fetchPlaylist(url, options);
  if (!hasMasterPlaylist(first)) {
    return { text: first, url, variants: [] };
  }

  const variants = parseMasterPlaylist(first, url);
  if (!variants.length) return { text: first, url, variants: [] };

  const cap = options.maxHeight ?? 2160;
  const withinCap = variants.filter((variant) => (variant.height ?? cap) <= cap);
  const chosen = (withinCap.length ? withinCap : variants)[0];
  if (!chosen) return { text: first, url, variants };
  const text = await fetchPlaylist(chosen.url, options);
  const resolved: ResolvedPlaylist = { text, url: chosen.url, variants };
  if (chosen.height) resolved.variantHeight = chosen.height;
  resolved.variantLabel = chosen.label;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Segment fetching                                                    */
/* ------------------------------------------------------------------ */

const keyCache = new Map<string, Promise<Buffer>>();

async function fetchKey(key: HlsKey, options: FetchOptions): Promise<Buffer> {
  const cached = keyCache.get(key.url);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetchWithTimeout(key.url, options);
    if (!response.ok) throw new Error(`the decryption key request failed (HTTP ${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== 16) throw new Error('the decryption key was not 16 bytes');
    return buffer;
  })();
  keyCache.set(key.url, pending);
  try {
    return await pending;
  } catch (error) {
    keyCache.delete(key.url);
    throw error;
  }
}

export function decryptSegment(payload: Buffer, keyData: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyData, iv);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

/** One segment's bytes, decrypted when the manifest asked for it. */
export async function fetchSegmentBuffer(
  segment: HlsSegment,
  options: FetchOptions = {},
): Promise<Buffer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (segment.byteRange) {
    headers.Range = `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}`;
  }
  // One attempt: the downloader already retries each segment, and a retry here
  // would multiply that (4 attempts × 3) while holding the window open.
  const response = await fetchWithTimeout(segment.url, { ...options, headers, retries: 0 });
  if (!response.ok && response.status !== 206) {
    throw new Error(`segment ${segment.index + 1} failed (HTTP ${response.status})`);
  }
  let buffer: Buffer = Buffer.from(await response.arrayBuffer());
  if (segment.key) {
    const keyData = await fetchKey(segment.key, options);
    buffer = decryptSegment(buffer, keyData, segment.key.iv ?? ivForSequence(segment.key, segment.index));
  }
  return buffer;
}

async function fetchInitBuffer(initUrl: string, options: FetchOptions): Promise<Buffer> {
  const response = await fetchWithTimeout(initUrl, { ...options, retries: 0 });
  if (!response.ok && response.status !== 206) {
    throw new Error(`the init segment failed (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Total length of one URL, asked for with a one-byte range. */
async function probeLength(url: string, options: FetchOptions): Promise<number | undefined> {
  try {
    const response = await fetchWithTimeout(url, { ...options, headers: { ...(options.headers ?? {}), Range: 'bytes=0-0' } });
    const range = response.headers.get('content-range');
    const length = range ? Number(range.split('/')[1]) : Number(response.headers.get('content-length') ?? 0);
    return Number.isFinite(length) && length > 0 ? length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Content-Length of every segment, so an uploader can declare a total upfront.
 *
 * The init segment counts: an fMP4 playlist's segments share one, the downloader
 * prepends it to the first, and its bytes end up in the published file. Leaving
 * them out made every such download look a little longer than its playlists
 * promised, which is a size the uploader can never match.
 */
export async function measureSegments(
  segments: HlsSegment[],
  options: FetchOptions & { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ bytes: number | undefined; sizes: Array<number | undefined>; measured: number; unknown: number }> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const sizes = new Array<number | undefined>(segments.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < segments.length) {
      const index = cursor++;
      const segment = segments[index];
      if (!segment) continue;
      if (segment.declaredBytes !== undefined) {
        sizes[index] = segment.declaredBytes;
      } else {
        sizes[index] = await probeLength(segment.url, options);
      }
      done += 1;
      options.onProgress?.(done, segments.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, segments.length)) }, worker));

  // Only the first segment carries the init bytes (the downloader prepends them
  // there and nowhere else), so that is the only size the init adds to.
  const initBytes = segments[0]?.initUrl ? await probeLength(segments[0].initUrl, options) : undefined;
  if (initBytes !== undefined && sizes[0] !== undefined) sizes[0] += initBytes;

  const unknown = sizes.filter((size) => size === undefined).length;
  if (unknown > 0) return { bytes: undefined, sizes, measured: sizes.length - unknown, unknown };
  const bytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  return { bytes, sizes, measured: sizes.length, unknown: 0 };
}

/* ------------------------------------------------------------------ */
/* Spool: the file being written at one end and read at the other      */
/* ------------------------------------------------------------------ */

export interface SpoolSegment {
  /** Where this segment starts in the spool file. */
  offset: number;
  /** How many bytes it actually occupies — measured sizes are only a plan. */
  bytes: number;
}

export class StreamSpool {
  readonly path: string;
  private writer: number;
  private closed = false;
  private appendQueue: Promise<void> = Promise.resolve();
  bytes = 0;
  failed?: string;
  /** Total bytes the plan expects; readers never wait past it. */
  total?: number;
  /** Actual byte span of every segment appended so far, in playlist order. */
  segments: SpoolSegment[] = [];
  /** Set once the downloader has finished (successfully or not). */
  done = false;

  constructor(directory: string, jobId: string, extension: 'ts' | 'mp4') {
    fs.mkdirSync(directory, { recursive: true });
    this.path = path.join(directory, `${jobId}.${extension}`);
    this.writer = fs.openSync(this.path, 'w');
  }

  /**
   * Appends one segment and records where it really landed.
   *
   * The downloader awaits every append, so the running byte count is the next
   * segment's offset; callers that append concurrently would break that.
   */
  appendSegment(buffer: Buffer): Promise<void> {
    const offset = this.bytes;
    this.segments.push({ offset, bytes: buffer.length });
    return this.append(buffer);
  }

  /** Buffers are appended strictly in call order — the downloader awaits each. */
  append(buffer: Buffer): Promise<void> {
    this.appendQueue = this.appendQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.closed) {
            reject(new Error('the spool is closed; nothing more can be appended to it'));
            return;
          }
          try {
            fs.writeSync(this.writer, buffer);
            this.bytes += buffer.length;
            resolve();
          } catch (error) {
            this.markFailed(error instanceof Error ? error.message : String(error));
            reject(error);
          }
        }),
    );
    return this.appendQueue;
  }

  markFailed(message: string): void {
    this.failed = message;
  }

  /**
   * Resolves once at least `offset` bytes are on disk, or the download failed.
   *
   * Polled rather than event-driven on purpose: the readers are 8 MiB chunk
   * uploads and 64 KiB relay reads, the writer produces megabytes per second,
   * and a 25 ms tick is far below what any of them can notice — while a waiter
   * registry would be one more piece of concurrent state to get wrong.
   */
  async waitFor(offset: number, signal?: AbortSignal, stallMs = 10 * 60_000): Promise<void> {
    const goal = this.total !== undefined ? Math.min(offset, this.total) : offset;
    let lastBytes = this.bytes;
    let lastProgress = Date.now();
    while (this.bytes < goal) {
      if (this.failed) throw new Error(this.failed);
      if (signal?.aborted) throw new Error('the download was cancelled');
      if (this.bytes !== lastBytes) {
        lastBytes = this.bytes;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > stallMs) {
        // A downloader that died without reporting it would otherwise leave a
        // reader parked here for as long as the process lives.
        throw new Error(`the download stalled at ${this.bytes} of ${goal} bytes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.failed) throw new Error(this.failed);
  }

  /**
   * Reads up to `length` bytes from `offset`, waiting for them to arrive.
   *
   * With a known total, the wait is for exactly the requested span (clamped to
   * that total) — which is what a TUS chunk needs. Without one, the wait is for
   * the *next* byte: there is no way to know whether a longer wait would ever be
   * satisfied, and a reader that returned nothing would be indistinguishable from
   * a stalled download.
   */
  async read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    const ceiling = this.total !== undefined ? Math.min(offset + length, this.total) : offset + 1;
    await this.waitFor(ceiling, signal);
    const available = Math.min(length, this.bytes - offset);
    if (available <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(available);
    const descriptor = fs.openSync(this.path, 'r');
    try {
      let read = 0;
      while (read < available) {
        const got = fs.readSync(descriptor, buffer, read, available - read, offset + read);
        if (got <= 0) break;
        read += got;
      }
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /**
   * The actual byte span of segment `index`, once the downloader has appended it.
   *
   * The measured plan can be wrong — an AES-encrypted source is smaller after
   * decryption, and a source that lies about a segment size breaks the sum — so a
   * relay serving one segment per request must use the bytes that really exist.
   * Undefined means the download ended without ever producing the segment.
   */
  async waitForSegment(index: number, signal?: AbortSignal, stallMs = 10 * 60_000): Promise<SpoolSegment | undefined> {
    let lastBytes = this.bytes;
    let lastProgress = Date.now();
    while (!this.segments[index]) {
      if (this.failed) throw new Error(this.failed);
      if (this.done) return undefined;
      if (signal?.aborted) throw new Error('the download was cancelled');
      if (this.bytes !== lastBytes) {
        lastBytes = this.bytes;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > stallMs) {
        throw new Error(`the download stalled before segment ${index + 1} (${this.bytes} bytes written)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.segments[index];
  }

  /** Total bytes, once the downloader has finished (undefined while it runs). */
  async finish(): Promise<number> {
    await this.appendQueue;
    this.close();
    this.done = true;
    // Once the download is over, the real byte count is the only truth readers
    // may wait for: a plan that overshot would otherwise park a reader forever.
    this.total = this.bytes;
    return this.bytes;
  }

  /**
   * Closes the writer exactly once.
   *
   * Closing the same descriptor number twice is not harmless: by the second
   * call the number can already belong to an unrelated open file (a reader, a
   * store write, another spool), and closing it would pull that file out from
   * under its owner. Both `finish()` and `remove()` come through here, in
   * whichever order the download and the cleanup race each other.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.writer);
    } catch {
      /* already closed */
    }
  }

  remove(): void {
    this.close();
    try {
      fs.rmSync(this.path, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface DownloadProgress {
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
}

/** Downloads every segment into the spool, in order, with a small window in flight. */
export async function downloadSegments(
  segments: HlsSegment[],
  spool: StreamSpool,
  options: FetchOptions & {
    concurrency?: number;
    attempts?: number;
    onProgress?: (progress: DownloadProgress) => void;
    shouldContinue?: () => boolean;
  } = {},
): Promise<void> {
  const window = Math.max(1, options.concurrency ?? 4);
  const attempts = Math.max(1, options.attempts ?? 4);
  const inflight = new Map<number, Promise<Buffer>>();
  const signal = options.signal;

  const load = async (index: number): Promise<Buffer> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.shouldContinue && !options.shouldContinue()) throw new Error('the download was cancelled');
      const segment = segments[index];
      if (!segment) throw new Error(`segment ${index + 1} is not in this playlist`);
      try {
        if (index === 0 && segment.initUrl) {
          const init = await fetchInitBuffer(segment.initUrl, options);
          return Buffer.concat([init, await fetchSegmentBuffer(segment, options)]);
        }
        return await fetchSegmentBuffer(segment, options);
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 500 * attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  let next = 0;
  try {
    while (next < segments.length) {
      for (let index = next; index < Math.min(segments.length, next + window); index += 1) {
        if (!inflight.has(index)) inflight.set(index, load(index));
      }
      const buffer = await inflight.get(next);
      inflight.delete(next);
      await spool.appendSegment(buffer ?? Buffer.alloc(0));
      next += 1;
      options.onProgress?.({ segmentsDone: next, segmentsTotal: segments.length, bytes: spool.bytes });
    }
  } catch (error) {
    spool.markFailed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
