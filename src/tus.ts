/**
 * TUS 1.0 resumable uploads to Bunny Stream.
 *
 * Bunny exposes a TUS endpoint at https://video.bunnycdn.com/tusupload. Each
 * request carries a SHA-256 presigned signature (library id + API key +
 * expiration + video id) that Bunny re-validates, so we sign freshly every
 * time. The file is sent in fixed-size chunks; a failed chunk is retried with
 * backoff and the authoritative offset is re-read with HEAD afterwards, so an
 * interrupted upload continues from Bunny's byte count instead of byte zero.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload';
export const TUS_VERSION = '1.0.0';

/** 8 MiB chunks keep a dropped connection cheap to replay without flooding the endpoint. */
export const DEFAULT_TUS_CHUNK_BYTES = 8 * 1024 * 1024;
/** Smaller chunks replay less data after a failure but need more requests. */
export const MIN_TUS_CHUNK_BYTES = 64 * 1024;
export const MAX_TUS_CHUNK_BYTES = 1024 * 1024 * 1024;

/** tus-js-client's schedule: retry immediately, then back off up to a minute. */
export const TUS_RETRY_DELAYS_MS = [0, 3_000, 5_000, 10_000, 20_000, 60_000, 60_000];

/** Bunny re-checks AuthorizationExpire on every request, so a day is plenty. */
export const TUS_AUTHORIZATION_TTL_SECONDS = 86_400;

const CONTROL_TIMEOUT_MS = 60_000;
const CHUNK_TIMEOUT_MS = 10 * 60_000;

export class TusError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TusError';
    if (status !== undefined) this.status = status;
  }
}

/** Raised when `shouldContinue` says the job was cancelled mid-upload. */
export class TusUploadAborted extends Error {
  constructor() {
    super('the upload was cancelled');
    this.name = 'TusUploadAborted';
  }
}

export interface TusAuth {
  libraryId: string;
  apiKey: string;
  videoId: string;
}

/**
 * Bunny validates SHA256(library_id + api_key + expiration_time + video_id).
 * The values must match the request headers byte-for-byte.
 */
export function tusSignature(auth: TusAuth, expirationSeconds: number): string {
  return crypto.createHash('sha256').update(`${auth.libraryId}${auth.apiKey}${expirationSeconds}${auth.videoId}`).digest('hex');
}

export function tusAuthHeaders(auth: TusAuth, nowMs: number, ttlSeconds = TUS_AUTHORIZATION_TTL_SECONDS): Record<string, string> {
  const expiration = Math.floor(nowMs / 1000) + ttlSeconds;
  return {
    AuthorizationSignature: tusSignature(auth, expiration),
    AuthorizationExpire: String(expiration),
    LibraryId: auth.libraryId,
    VideoId: auth.videoId,
  };
}

/** TUS metadata is comma-separated `key base64(value)` pairs. */
export function tusMetadata(entries: Record<string, string | undefined>): string {
  return Object.entries(entries)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');
}

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
};

export function guessVideoContentType(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return VIDEO_CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function parseUploadOffset(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : undefined;
}

export function clampChunkBytes(value: unknown): number {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_TUS_CHUNK_BYTES;
  return Math.max(MIN_TUS_CHUNK_BYTES, Math.min(MAX_TUS_CHUNK_BYTES, Math.floor(bytes)));
}

/** Lost connections, timeouts, rate limits, and offset conflicts are all worth retrying. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 423 || status === 429 || status >= 500;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TusHttpResult {
  status: number;
  ok: boolean;
  uploadOffset?: number;
  location?: string;
}

async function send(
  fetchImpl: typeof fetch,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
): Promise<TusHttpResult> {
  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body ? { body: body as unknown as NonNullable<RequestInit['body']> } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
  const result: TusHttpResult = { status: response.status, ok: response.ok };
  const offset = parseUploadOffset(response.headers.get('upload-offset'));
  if (offset !== undefined) result.uploadOffset = offset;
  const location = response.headers.get('location');
  if (location) result.location = location;
  await response.arrayBuffer().catch(() => undefined);
  return result;
}

interface RetryContext {
  delays: number[];
  sleep: (ms: number) => Promise<void>;
  abortIfAsked: () => void;
  describe: string;
}

async function sendWithRetry(request: () => Promise<TusHttpResult>, context: RetryContext): Promise<TusHttpResult> {
  let last: unknown;
  for (let attempt = 0; attempt <= context.delays.length; attempt += 1) {
    if (attempt > 0) await context.sleep(context.delays[attempt - 1] ?? 0);
    context.abortIfAsked();
    try {
      const result = await request();
      if (result.ok || !isRetryableStatus(result.status)) return result;
      last = new TusError(`Bunny answered HTTP ${result.status}`, result.status);
    } catch (error) {
      if (error instanceof TusUploadAborted) throw error;
      last = error;
    }
    context.abortIfAsked();
  }
  const status = last instanceof TusError ? last.status : undefined;
  throw new TusError(`${context.describe} failed after ${context.delays.length + 1} attempts: ${describeError(last)}`, status);
}

function readChunk(filePath: string, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let read = 0;
    while (read < length) {
      const bytes = fs.readSync(descriptor, buffer, read, length - read, position + read);
      if (bytes <= 0) break;
      read += bytes;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * The bytes a TUS upload sends, wherever they come from.
 *
 * A file on disk is the ordinary case; a spool file still being written by an
 * HLS downloader is the other one, and it is why this exists — the upload needs
 * a total length upfront (TUS demands it) but must not wait for the download to
 * finish before it starts sending. A source that blocks until the bytes it was
 * asked for exist gives both at once.
 */
export interface TusSource {
  totalBytes: number;
  /** Reads `length` bytes from `offset`, waiting for them when they are still arriving. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
}

export function fileTusSource(filePath: string): TusSource {
  try {
    return { totalBytes: fs.statSync(filePath).size, read: async (offset, length) => readChunk(filePath, offset, length) };
  } catch {
    const bytes = 0;
    return { totalBytes: bytes, read: async () => Buffer.alloc(0) };
  }
}

export interface TusUploadOptions {
  libraryId: string;
  apiKey: string;
  videoId: string;
  /** A file on disk; ignored when `source` is given. */
  filePath?: string;
  /** Where the bytes come from (defaults to [fileTusSource] over `filePath`). */
  source?: TusSource;
  title: string;
  /** Used for the filetype metadata (defaults to the file path's own name). */
  fileName?: string;
  filetype?: string;
  /** The Location returned by a previous attempt, so a restart can resume in place. */
  resumeUrl?: string;
  chunkBytes?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
  onUploadUrl?: (uploadUrl: string) => void;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  shouldContinue?: () => boolean;
}

export interface TusUploadResult {
  uploadUrl: string;
  bytesSent: number;
  totalBytes: number;
  /** True when this attempt continued an earlier partial upload. */
  resumed: boolean;
}

export async function tusUpload(options: TusUploadOptions): Promise<TusUploadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.retryDelaysMs ?? TUS_RETRY_DELAYS_MS;
  const chunkBytes = clampChunkBytes(options.chunkBytes);
  const endpoint = options.endpoint ?? TUS_ENDPOINT;
  const source =
    options.source ??
    (() => {
      if (!options.filePath) throw new TusError('the upload was given neither a file nor a byte source');
      return fileTusSource(options.filePath);
    })();
  const totalBytes = source.totalBytes;
  const auth: TusAuth = { libraryId: options.libraryId, apiKey: options.apiKey, videoId: options.videoId };

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'Tus-Resumable': TUS_VERSION,
    ...tusAuthHeaders(auth, now()),
    ...extra,
  });

  const abortIfAsked = (): void => {
    if (options.shouldContinue && !options.shouldContinue()) throw new TusUploadAborted();
  };

  let uploadUrl = options.resumeUrl;
  let offset = 0;
  let resumed = false;

  const control: RetryContext = { delays, sleep, abortIfAsked, describe: 'the Bunny upload request' };

  // 1. Continue an earlier attempt when Bunny still knows about it.
  if (uploadUrl) {
    const head = await sendWithRetry(() => send(fetchImpl, 'HEAD', uploadUrl as string, headers(), undefined, CONTROL_TIMEOUT_MS), control);
    if (head.status === 404 || head.status === 410) {
      uploadUrl = undefined; // expired (or the video was deleted): fall through to a fresh session
    } else if (head.ok) {
      const serverOffset = head.uploadOffset ?? 0;
      if (serverOffset > totalBytes) uploadUrl = undefined; // stale session for a different, longer file
      else {
        offset = serverOffset;
        resumed = offset > 0;
      }
    } else {
      throw new TusError(`could not resume the previous Bunny upload (HTTP ${head.status})`, head.status);
    }
  }

  // 2. Create an upload session when there is none left to continue.
  if (!uploadUrl) {
    abortIfAsked();
    const metadata = tusMetadata({
      filetype: options.filetype ?? guessVideoContentType(options.fileName ?? options.filePath ?? 'upload.bin'),
      title: options.title,
    });
    const created = await sendWithRetry(
      () =>
        send(
          fetchImpl,
          'POST',
          endpoint,
          headers({ 'Upload-Length': String(totalBytes), 'Upload-Metadata': metadata }),
          undefined,
          CONTROL_TIMEOUT_MS,
        ),
      { ...control, describe: 'creating the Bunny upload session' },
    );
    if (created.status === 404 || created.status === 410) {
      throw new TusError('Bunny has no upload session for this video — it expired or the video was deleted', created.status);
    }
    if (!created.ok) throw new TusError(`Bunny rejected the resumable upload (HTTP ${created.status})`, created.status);
    if (!created.location) throw new TusError('Bunny did not return an upload location');
    uploadUrl = new URL(created.location, endpoint).toString();
    offset = Math.min(created.uploadOffset ?? 0, totalBytes);
    options.onUploadUrl?.(uploadUrl);
  }

  options.onProgress?.(offset, totalBytes);

  // 3. Stream the file chunk by chunk; every failure re-syncs with HEAD.
  let consecutiveFailures = 0;
  while (offset < totalBytes) {
    abortIfAsked();
    const end = Math.min(totalBytes, offset + chunkBytes);
    const chunk = await source.read(offset, end - offset);
    if (chunk.length === 0) throw new TusError(`the local file ended early at byte ${offset} of ${totalBytes}`);
    try {
      const patch = await send(
        fetchImpl,
        'PATCH',
        uploadUrl,
        headers({ 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) }),
        chunk,
        CHUNK_TIMEOUT_MS,
      );
      if (!patch.ok) throw new TusError(`Bunny refused the chunk at byte ${offset} (HTTP ${patch.status})`, patch.status);
      if (patch.uploadOffset === undefined) throw new TusError('Bunny did not report the new upload offset');
      if (patch.uploadOffset <= offset) throw new TusError(`the upload offset did not advance past byte ${offset}`);
      offset = Math.min(patch.uploadOffset, totalBytes);
      consecutiveFailures = 0;
    } catch (error) {
      if (error instanceof TusUploadAborted) throw error;
      const status = error instanceof TusError ? error.status : undefined;
      if (status !== undefined && !isRetryableStatus(status)) throw error;
      consecutiveFailures += 1;
      if (consecutiveFailures > delays.length) {
        throw new TusError(`the upload gave up at byte ${offset} of ${totalBytes}: ${describeError(error)}`, status);
      }
      await sleep(delays[consecutiveFailures - 1] ?? 0);
      abortIfAsked();
      // Ask Bunny how much it actually stored: the failed request may have landed partially.
      try {
        const head = await sendWithRetry(() => send(fetchImpl, 'HEAD', uploadUrl as string, headers(), undefined, CONTROL_TIMEOUT_MS), control);
        if (head.status === 404 || head.status === 410) {
          throw new TusError("the resumable upload expired on Bunny's side", head.status);
        }
        if (head.ok) offset = Math.min(head.uploadOffset ?? offset, totalBytes);
      } catch (headError) {
        if (headError instanceof TusUploadAborted) throw headError;
        if (headError instanceof TusError && (headError.status === 404 || headError.status === 410)) throw headError;
        /* stay at the local offset and retry the chunk */
      }
    }
    options.onProgress?.(offset, totalBytes);
  }

  return { uploadUrl, bytesSent: offset, totalBytes, resumed };
}
