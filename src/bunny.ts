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
import { DEFAULT_TUS_CHUNK_BYTES, TusError, TusUploadAborted, fileTusSource, tusUpload, type TusSource, type TusUploadResult } from './tus';

/**
 * A byte source as the web stream a `PUT` body has to be.
 *
 * The source is read strictly forwards, one chunk per pull, so the bytes are
 * never held anywhere but in the request — the point of a streamed upload.
 */
function tusSourceStream(source: TusSource, chunkBytes = DEFAULT_TUS_CHUNK_BYTES): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= source.totalBytes) {
        controller.close();
        return;
      }
      const chunk = await source.read(offset, Math.min(chunkBytes, source.totalBytes - offset));
      if (!chunk.length) {
        controller.close();
        return;
      }
      offset += chunk.length;
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
    },
  });
}

export interface BunnyCaption {
  srclang: string;
  label: string;
  version?: number;
}

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
  /** The caption tracks the video carries, as Bunny reports them. */
  captions?: BunnyCaption[] | null;
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

/**
 * The pull zone's base URL, from whatever the account stored.
 *
 * Every file a finished video exposes — the HLS playlist, the per-resolution
 * MP4 fallbacks, the thumbnails, the animated previews — is served from the same
 * host, so the account's `pullZoneHost` is normalised once here (`cdn.b-cdn.net`,
 * `https://cdn.b-cdn.net/` and `https://cdn.b-cdn.net` all read the same) and
 * every URL below is built from the result.
 */
export function pullZoneBase(pullZoneHost: string | undefined): string | undefined {
  if (!pullZoneHost) return undefined;
  const value = pullZoneHost.trim().replace(/\/+$/, '');
  if (!value) return undefined;
  // A bare hostname (`vz-abc.b-cdn.net`) is what the dashboard asks for, and
  // https is the only scheme a real pull zone speaks. An explicit scheme is kept
  // as given, which is what lets a local stand-in be pointed at in a test.
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

/** Playback needs the library's pull-zone hostname, which the Stream API does not return. */
export function playbackUrlFor(pullZoneHost: string | undefined, videoId: string): string | undefined {
  const base = pullZoneBase(pullZoneHost);
  return base ? `${base}/${videoId}/playlist.m3u8` : undefined;
}

/** The URL of one file inside a video's folder on the pull zone. */
export function bunnyFileUrl(base: string, videoId: string, path: string): string {
  return `${base}/${encodeURIComponent(videoId)}/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/**
 * The MP4 fallbacks stop at 1080p, however tall the source is: asking for
 * `play_2160p.mp4` is a 404 even when the ladder has a 4K rung.
 */
export const MP4_FALLBACK_MAX_HEIGHT = 1080;

/**
 * The heights inside `availableResolutions` (`"240p,360p,480p,720p"`).
 *
 * The field is absent on some videos and free-form when it is there, so a value
 * that does not parse as a height is dropped rather than guessed at. The numbers,
 * not the labels, are what the MP4 fallback URLs are built from.
 */
export function parseResolutions(availableResolutions: string | undefined): number[] {
  if (!availableResolutions) return [];
  const heights = new Set<number>();
  for (const match of String(availableResolutions).matchAll(/(\d{3,4})\s*p?/gi)) {
    const height = Number(match[1]);
    if (Number.isFinite(height) && height > 0) heights.add(height);
  }
  return [...heights].sort((a, b) => b - a);
}

/**
 * The ladder tried when `availableResolutions` is missing.
 *
 * A finished video that encoded normally has some subset of these; each is
 * HEAD-ed before it is downloaded, so a rung the library never produced is
 * skipped rather than guessed at.
 */
export const DEFAULT_RESOLUTION_LADDER = [1080, 720, 480, 360, 240];

/** One downloadable file a finished video exposes on its pull zone. */
export interface BunnyAsset {
  /** Where it sits inside the video's folder, e.g. `play_720p.mp4`. */
  path: string;
  /** The pull-zone URL to download it from. */
  url: string;
  contentType: string;
  kind: 'video' | 'original' | 'playlist' | 'thumbnail' | 'preview';
}

/**
 * Every file a finished video exposes that is worth keeping.
 *
 * The MP4 fallbacks are the only place the *encoded* video can be downloaded
 * from (the HLS segments are the same bytes cut into thousands of pieces), so
 * they are the point of an archive; `original` is the file that was uploaded in
 * the first place, when the library stores it. The images are every thumbnail
 * and every animated preview Bunny generated.
 *
 * Player seek sprites are not listed here — how many exist is not reported
 * anywhere, so `BunnyClient`-side callers probe `seek/_<n>.jpg` until one is
 * missing instead of guessing a count.
 */
export function bunnyAssets(video: BunnyVideo, base: string): BunnyAsset[] {
  const id = video.guid;
  const assets: BunnyAsset[] = [];
  const ladder = parseResolutions(video.availableResolutions);
  const heights = ladder.length ? ladder : DEFAULT_RESOLUTION_LADDER;
  for (const height of heights) {
    if (height > MP4_FALLBACK_MAX_HEIGHT) continue;
    const path = `play_${height}p.mp4`;
    assets.push({ path, url: bunnyFileUrl(base, id, path), contentType: 'video/mp4', kind: 'video' });
  }
  assets.push({ path: 'original', url: bunnyFileUrl(base, id, 'original'), contentType: 'application/octet-stream', kind: 'original' });
  assets.push({ path: 'playlist.m3u8', url: bunnyFileUrl(base, id, 'playlist.m3u8'), contentType: 'application/vnd.apple.mpegurl', kind: 'playlist' });
  for (let index = 0; index <= 5; index += 1) {
    const path = index === 0 ? 'thumbnail.jpg' : `thumbnail_${index}.jpg`;
    assets.push({ path, url: bunnyFileUrl(base, id, path), contentType: 'image/jpeg', kind: 'thumbnail' });
  }
  const previews: Array<[string, string]> = [
    ['preview.webp', 'image/webp'],
    ['preview.gif', 'image/gif'],
    ['preview_hq.webm', 'video/webm'],
    ['preview_hq.mp4', 'video/mp4'],
  ];
  for (const [path, contentType] of previews) {
    assets.push({ path, url: bunnyFileUrl(base, id, path), contentType, kind: 'preview' });
  }
  return assets;
}

/** One of the player's seek-thumbnail sprite sheets, numbered from `_0.jpg`. */
export function seekSpriteUrl(base: string, videoId: string, index: number): string {
  return bunnyFileUrl(base, videoId, `seek/_${index}.jpg`);
}

/** How many seek sprites to probe before assuming the last one was reached. */
export const MAX_SEEK_SPRITES = 200;

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
   * Raw binary PUT, streamed from a byte source rather than a file.
   *
   * The same single attempt as [uploadVideo], with the same ceiling, but the
   * body is pulled straight off the source as the request is written — so a
   * caller holding an object in R2 (or anywhere else) can hand it over without
   * ever putting it on disk first.
   */
  async uploadVideoStream(videoId: string, source: TusSource): Promise<void> {
    if (this.mock) return;
    const response = await this.send(
      `${this.base}/videos/${encodeURIComponent(videoId)}`,
      {
        method: 'PUT',
        headers: {
          AccessKey: this.apiKey,
          accept: 'application/json',
          'content-type': 'application/octet-stream',
          'content-length': String(source.totalBytes),
        },
        body: tusSourceStream(source) as unknown as NonNullable<RequestInit['body']>,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
      { timeoutMs: 30 * 60_000, retries: 0 },
    );
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

  /**
   * Attaches a caption track to a video.
   *
   * Bunny takes the subtitle text base64-encoded in JSON, keyed by the SRCLANG
   * route segment, and answers `200` even when it decided the file was invalid —
   * the real verdict is in `data.valid`/`data.errorList`. A rejected caption is
   * therefore raised here rather than reported as success.
   */
  async addCaption(videoId: string, srclang: string, label: string, content: string | Buffer): Promise<void> {
    const code = srclang.trim().toLowerCase();
    if (!code) throw new BunnyError('a caption needs a language code');
    if (this.mock) {
      mockAddCaption(videoId, code, label);
      return;
    }
    const captionsFile = Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf8').toString('base64');
    const response = await this.send(`${this.base}/videos/${encodeURIComponent(videoId)}/captions/${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { AccessKey: this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ srclang: code, label, captionsFile }),
    });
    await this.ensureOk(response);
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      message?: string;
      data?: { valid?: boolean; errorList?: string[]; warningList?: string[] };
    };
    if (body.success === false || body.data?.valid === false) {
      const detail = body.data?.errorList?.join('; ') || body.message || 'Bunny rejected the caption file';
      throw new BunnyError(`Bunny rejected the ${code} caption: ${detail}`, response.status);
    }
  }

  /** The caption tracks Bunny already holds for a video. */
  async listCaptions(videoId: string): Promise<BunnyCaption[]> {
    const video = await this.getVideo(videoId);
    return Array.isArray(video.captions) ? video.captions : [];
  }

  async deleteCaption(videoId: string, srclang: string): Promise<void> {
    const code = srclang.trim().toLowerCase();
    if (this.mock) {
      MOCK_CAPTIONS.get(videoId)?.delete(code);
      return;
    }
    const response = await this.send(`${this.base}/videos/${encodeURIComponent(videoId)}/captions/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { AccessKey: this.apiKey, accept: 'application/json' },
    });
    await this.ensureOk(response);
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
/** Caption tracks the mock library has been handed, per video. */
const MOCK_CAPTIONS = new Map<string, Map<string, BunnyCaption>>();
const MOCK_ENCODE_MS = 20_000;

function mockAddCaption(videoId: string, srclang: string, label: string): void {
  const tracks = MOCK_CAPTIONS.get(videoId) ?? new Map<string, BunnyCaption>();
  const previous = tracks.get(srclang);
  tracks.set(srclang, { srclang, label, version: (previous?.version ?? 0) + 1 });
  MOCK_CAPTIONS.set(videoId, tracks);
}

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
    captions: [...(MOCK_CAPTIONS.get(videoId)?.values() ?? [])],
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
