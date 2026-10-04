/**
 * Minimal Bunny Stream client: create a video object, upload a local file
 * (resumable TUS chunks, or a single raw PUT), hand Bunny a remote URL to
 * fetch, read encoding status, delete.
 *
 * Mock mode simulates a library that finishes encoding in ~20 seconds so the
 * dashboard can be exercised without Bunny credentials.
 */
import fs from 'node:fs';
import { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS, NetworkError, fetchWithPolicy } from './net';
import { TusError, TusUploadAborted, fileTusSource, tusUpload, type TusSource, type TusUploadResult } from './tus';

export interface BunnyVideo {
  guid: string;
  title: string;
  status: number;
  encodeProgress: number;
  length: number;
  storageSize?: number;
  thumbnailUrl?: string;
  availableResolutions?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export interface BunnyFetchResult {
  success: boolean;
  statusCode?: number;
  message?: string;
}

export class BunnyError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BunnyError';
    if (status !== undefined) this.status = status;
  }
}

export const BUNNY_STATUS_LABELS: Record<number, string> = {
  0: 'created',
  1: 'uploaded',
  2: 'processing',
  3: 'transcoding',
  4: 'finished',
  5: 'error',
  6: 'upload failed',
  7: 'jit segmenting',
  8: 'jit playlists created',
};

export type BunnyOutcome = 'active' | 'ready' | 'failed';

/** 4 = Finished, 8 = JIT playlists created; 5/6 = the two failure states. */
export function mapBunnyStatus(status: number): BunnyOutcome {
  if (status === 4 || status === 8) return 'ready';
  if (status === 5 || status === 6) return 'failed';
  return 'active';
}

export function bunnyStatusLabel(status: number): string {
  return BUNNY_STATUS_LABELS[status] ?? `status ${status}`;
}

/** Playback needs the library's pull-zone hostname, which the Stream API does not return. */
export function playbackUrlFor(pullZoneHost: string | undefined, videoId: string): string | undefined {
  if (!pullZoneHost) return undefined;
  const host = pullZoneHost.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host) return undefined;
  return `https://${host}/${videoId}/playlist.m3u8`;
}

interface BunnyClientOptions {
  apiKey: string;
  libraryId: string;
  fetchImpl?: typeof fetch;
  mock?: boolean;
  /** Per-attempt ceiling for the control plane (default [DEFAULT_FETCH_TIMEOUT_MS]). */
  timeoutMs?: number;
  /** Extra attempts after the first, for a flaky network (default 3). */
  retries?: number;
}

export class BunnyClient {
  private apiKey: string;
  private libraryId: string;
  private fetchImpl: typeof fetch;
  private mock: boolean;
  private timeoutMs?: number;
  private retries?: number;

  constructor(options: BunnyClientOptions) {
    this.apiKey = options.apiKey;
    this.libraryId = options.libraryId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mock = options.mock ?? false;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
    if (options.retries !== undefined) this.retries = options.retries;
  }

  /**
   * Every control-plane call, with the shared timeout/retry policy.
   *
   * The policy is what turns a hung connection into either a finished request or
   * an error that says which host, how long and what the transport said — the
   * difference between "it does not work" and something to act on.
   */
  private async send(url: string, init: RequestInit = {}, overrides: { timeoutMs?: number; retries?: number } = {}): Promise<Response> {
    try {
      return await fetchWithPolicy(url, init, {
        what: 'the Bunny API',
        fetchImpl: this.fetchImpl,
        timeoutMs: overrides.timeoutMs ?? this.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        retries: overrides.retries ?? this.retries ?? DEFAULT_FETCH_RETRIES,
      });
    } catch (error) {
      if (error instanceof NetworkError) throw new BunnyError(error.message, error.status);
      throw error;
    }
  }

  private get base(): string {
    return `https://video.bunnycdn.com/library/${encodeURIComponent(this.libraryId)}`;
  }

  private async ensureOk(response: Response): Promise<void> {
    if (response.ok) return;
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      /* not every error is JSON */
    }
    const hint = response.status === 401 ? ' — check the Stream library API key and library ID' : '';
    throw new BunnyError(`Bunny request failed (${response.status})${detail ? `: ${detail}` : hint}`, response.status);
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(`${this.base}${pathname}`, {
      ...init,
      headers: {
        AccessKey: this.apiKey,
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    await this.ensureOk(response);
    return (await response.json().catch(() => ({}))) as T;
  }



  async createVideo(title: string): Promise<BunnyVideo> {
    if (this.mock) return mockCreate(title);
    return this.request<BunnyVideo>('/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  }

  /**
   * Raw binary PUT, streamed from disk; Bunny encodes whatever it receives.
   *
   * One attempt with a long ceiling: a body that is already half sent cannot be
   * retried cheaply, and this is the fallback path (`UPLOAD_MODE=put`) rather
   * than the default resumable one.
   */
  async uploadVideo(videoId: string, filePath: string): Promise<void> {
    if (this.mock) return;
    const { size } = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    const response = await this.send(`${this.base}/videos/${encodeURIComponent(videoId)}`, {
      method: 'PUT',
      headers: {
        AccessKey: this.apiKey,
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: stream as unknown as NonNullable<RequestInit['body']>,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }, { timeoutMs: 30 * 60_000, retries: 0 });
    await this.ensureOk(response);
  }

  /**
   * Resumable TUS upload: fixed-size chunks with retries, and a HEAD re-sync
   * after every failure so a dropped connection continues from Bunny's byte
   * count. Pass the previous attempt's `resumeUrl` to continue in place.
   */
  async uploadVideoResumable(
    videoId: string,
    filePath: string | undefined,
    options: {
      title: string;
      fileName?: string;
      /** A growing file or any other byte source, instead of a finished file. */
      source?: TusSource;
      resumeUrl?: string;
      chunkBytes?: number;
      onUploadUrl?: (uploadUrl: string) => void;
      onProgress?: (bytesSent: number, totalBytes: number) => void;
      shouldContinue?: () => boolean;
    },
  ): Promise<TusUploadResult> {
    const source = options.source ?? (filePath ? fileTusSource(filePath) : undefined);
    if (!source) throw new BunnyError('the upload was given neither a file nor a byte source');
    const size = source.totalBytes;
    if (this.mock) return { uploadUrl: `mock://tus/${videoId}`, bytesSent: size, totalBytes: size, resumed: false };
    try {
      return await tusUpload({
        libraryId: this.libraryId,
        apiKey: this.apiKey,
        videoId,
        source,
        title: options.title,
        fileName: options.fileName ?? filePath ?? 'upload.bin',
        fetchImpl: this.fetchImpl,
        ...(options.resumeUrl ? { resumeUrl: options.resumeUrl } : {}),
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        ...(options.onUploadUrl ? { onUploadUrl: options.onUploadUrl } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.shouldContinue ? { shouldContinue: options.shouldContinue } : {}),
      });
    } catch (error) {
      if (error instanceof TusUploadAborted) throw error;
      if (error instanceof TusError) throw new BunnyError(error.message, error.status);
      throw error;
    }
  }

  /** Ask Bunny to pull the file itself (no local copy needed). */
  async fetchFromUrl(url: string, title?: string): Promise<BunnyFetchResult> {
    if (this.mock) return mockFetch(title ?? 'fetched video');
    return this.request<BunnyFetchResult>('/videos/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { url, title } : { url }),
    });
  }

  async getVideo(videoId: string): Promise<BunnyVideo> {
    if (this.mock) return mockGet(videoId);
    return this.request<BunnyVideo>(`/videos/${encodeURIComponent(videoId)}`);
  }

  async listVideos(limit = 1): Promise<{ totalItems?: number; items?: BunnyVideo[] }> {
    if (this.mock) return mockList(limit);
    return this.request(`/videos?page=1&itemsPerPage=${Math.max(1, Math.floor(limit))}`);
  }

  async deleteVideo(videoId: string): Promise<void> {
    if (this.mock) {
      MOCK_LIBRARY.delete(videoId);
      return;
    }
    const response = await this.send(`${this.base}/videos/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
      headers: { AccessKey: this.apiKey, accept: 'application/json' },
    });
    await this.ensureOk(response);
  }
}

/* ------------------------------------------------------------------ */
/* Mock library: encodes in ~20 seconds, then reports "finished"       */
/* ------------------------------------------------------------------ */

const MOCK_LIBRARY = new Map<string, { title: string; started: number }>();
const MOCK_ENCODE_MS = 20_000;

function mockCreate(title: string): BunnyVideo {
  const guid = `mock-${Math.random().toString(36).slice(2, 10)}`;
  MOCK_LIBRARY.set(guid, { title, started: Date.now() });
  return { guid, title, status: 1, encodeProgress: 0, length: 0 };
}

/**
 * `POST /videos/fetch` makes a video of its own and returns no id: mock mode
 * has to register it so the job can find it by title, exactly like the real
 * endpoint leaves the dashboard to do.
 */
function mockFetch(title: string): BunnyFetchResult {
  mockCreate(title);
  return { success: true, statusCode: 200, message: 'OK (mock)' };
}

function mockGet(videoId: string): BunnyVideo {
  const entry = MOCK_LIBRARY.get(videoId);
  if (!entry) MOCK_LIBRARY.set(videoId, { title: `mock video ${videoId}`, started: Date.now() });
  const started = MOCK_LIBRARY.get(videoId)?.started ?? Date.now();
  const ratio = Math.min(1, (Date.now() - started) / MOCK_ENCODE_MS);
  return {
    guid: videoId,
    title: MOCK_LIBRARY.get(videoId)?.title ?? 'mock video',
    status: ratio >= 1 ? 4 : 3,
    encodeProgress: Math.round(ratio * 100),
    length: 90,
  };
}

function mockList(limit: number): { totalItems: number; items: BunnyVideo[] } {
  const items = [...MOCK_LIBRARY.entries()]
    .sort((a, b) => b[1].started - a[1].started)
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(([guid, entry]) => ({
      ...mockGet(guid),
      title: entry.title,
      dateUploaded: new Date(entry.started).toISOString(),
    }));
  return { totalItems: MOCK_LIBRARY.size, items };
}

// A mock library starts with a little content, like a real library would.
for (const title of ['Sample Feature', 'Sample Documentary', 'Sample Short']) {
  const seeded = mockCreate(title).guid;
  MOCK_LIBRARY.set(seeded, { title, started: Date.now() - MOCK_ENCODE_MS - 60_000 });
}
