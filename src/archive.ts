/**
 * The R2 archive: once a title has finished encoding in Bunny, copy everything
 * Bunny made of it into Cloudflare R2 — every MP4 rendition, the original file,
 * the HLS playlist, every thumbnail, every animated preview, the player's seek
 * sprites and every caption — verify each object landed, and only then ask Bunny
 * to forget the video.
 *
 * Why copy at all: Bunny Stream is a *player*. Its per-resolution MP4 fallbacks
 * are the only place the encoded video can be downloaded from, its thumbnails
 * and preview animations only exist under its pull zone, and deleting the video
 * takes all of it away. R2 holds the same bytes as plain objects under keys a
 * bucket browser can sort, which is what makes "remove it from Bunny" safe
 * rather than destructive.
 *
 * The order matters and is the whole design: nothing is deleted until every
 * object is uploaded *and* confirmed with a HEAD against R2, and a title with no
 * downloadable MP4 at all is never deleted (there would be nothing left to
 * play). A failed archive leaves Bunny exactly as it was.
 *
 * The layout is deliberately readable, because a bucket full of `video-<guid>`
 * is not something anyone can sort:
 *
 *   archive/Movies/Inception (2010) [27205]/
 *     video/1080p.mp4        every MP4 fallback rendition
 *     video/720p.mp4
 *     original               the file that was uploaded, when Bunny kept it
 *     hls/playlist.m3u8      the HLS index the renditions belong to
 *     images/thumbnail.jpg   every thumbnail, and
 *     images/preview.gif     every animated preview (gif, webp, webm, mp4)
 *     sprites/seek_0.jpg     the player's timeline sprites
 *     subtitles/en.vtt       every caption track
 *     manifest.json          what all of it is, with a SHA-256 per object
 *
 * `manifest.json` is written last: its presence is what "this folder is a
 * complete archive" means, so a half-finished run cannot be mistaken for a
 * finished one.
 */
import { bunnyAssets, mapBunnyStatus, MAX_SEEK_SPRITES, pullZoneBase, seekSpriteUrl, type BunnyClient, type BunnyVideo } from './bunny';
import type { Catalog, CatalogArchive, CatalogArchiveObject, CatalogEntry } from './catalog';
import type { AppConfig } from './config';
import { fetchWithPolicy } from './net';
import { R2Client, type R2UploadResult } from './r2';

/** How long one asset download may take: a feature-length MP4 can be big. */
const ASSET_TIMEOUT_MS = 30 * 60_000;

/** The control-plane ceiling for a HEAD against the pull zone. */
const ASSET_HEAD_TIMEOUT_MS = 30_000;

/** Attempts for one title before the queue gives up and leaves Bunny alone. */
export const ARCHIVE_ATTEMPTS = 3;

/** The wait before the next attempt, doubled each time (a CDN hiccup clears). */
export const ARCHIVE_RETRY_MS = 5 * 60_000;

/** One file planned for the archive, before anything has been uploaded. */
export interface PlannedAsset {
  /** Where it goes inside the title's folder, e.g. `video/1080p.mp4`. */
  name: string;
  kind: CatalogArchiveObject['kind'];
  /** The pull-zone URL to download it from. */
  url: string;
  contentType: string;
}

/**
 * A folder-safe, human-sortable form of a title.
 *
 * Everything that would break a path or a URL is dropped rather than escaped
 * (`/`, `\`, `:`, `?`, quotes, control characters), whitespace collapses, and
 * the result is capped — a 300-character episode description makes a key nobody
 * can read. An empty result falls back, so a folder is never named nothing.
 */
export function archiveSlug(value: string | undefined, fallback: string): string {
  const cleaned = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function pad(value: number | undefined): string {
  return String(Math.max(0, Math.floor(value ?? 0))).padStart(2, '0');
}

/** The folder every asset of one title is filed under. */
export function archiveFolder(prefix: string, entry: CatalogEntry): string {
  if (entry.kind === 'episode') {
    const show = archiveSlug(entry.title, `show-${entry.tmdbId}`);
    const episode = archiveSlug(entry.episodeTitle, `S${pad(entry.season)}E${pad(entry.episode)}`);
    return `${prefix}/Shows/${show} [${entry.tmdbId}]/Season ${pad(entry.season)}/S${pad(entry.season)}E${pad(entry.episode)} - ${episode}`;
  }
  const name = archiveSlug(entry.title, `movie-${entry.tmdbId}`);
  const year = entry.year ? ` (${archiveSlug(entry.year, '')})` : '';
  return `${prefix}/Movies/${name}${year} [${entry.tmdbId}]`;
}

/** Every caption language the catalogue recorded or Bunny still reports. */
export function captionLanguages(entry: CatalogEntry, video: BunnyVideo): string[] {
  const languages = new Set<string>();
  for (const track of entry.subtitles ?? []) {
    if (track.srclang) languages.add(track.srclang.trim().toLowerCase());
  }
  for (const caption of Array.isArray(video.captions) ? video.captions : []) {
    if (caption?.srclang) languages.add(String(caption.srclang).trim().toLowerCase());
  }
  return [...languages].filter(Boolean).sort();
}

/**
 * What a finished video's folder will contain, before anything is downloaded.
 *
 * The seek sprites are left out: how many Bunny generated is not reported
 * anywhere, so they are discovered by probing (`spriteIndexes`) rather than
 * guessed into the plan.
 */
export function planAssets(video: BunnyVideo, base: string, captions: string[]): PlannedAsset[] {
  const planned: PlannedAsset[] = [];
  for (const asset of bunnyAssets(video, base)) {
    if (asset.kind === 'video') {
      // `play_1080p.mp4` becomes `video/1080p.mp4`: the rendition is the useful
      // part of the name, not Bunny's own prefix.
      const height = /play_(\d+)p\.mp4$/.exec(asset.path)?.[1] ?? asset.path.replace(/\.mp4$/, '');
      planned.push({ name: `video/${height}p.mp4`, kind: 'video', url: asset.url, contentType: asset.contentType });
    } else if (asset.kind === 'playlist') {
      planned.push({ name: 'hls/playlist.m3u8', kind: 'playlist', url: asset.url, contentType: asset.contentType });
    } else if (asset.kind === 'original') {
      planned.push({ name: 'original', kind: 'original', url: asset.url, contentType: asset.contentType });
    } else {
      planned.push({ name: `images/${asset.path}`, kind: asset.kind, url: asset.url, contentType: asset.contentType });
    }
  }
  for (const srclang of captions) {
    planned.push({
      name: `subtitles/${srclang}.vtt`,
      kind: 'subtitle',
      url: `${base}/${encodeURIComponent(video.guid)}/captions/${encodeURIComponent(srclang)}.vtt`,
      contentType: 'text/vtt',
    });
  }
  return planned;
}

export interface ArchiveOutcome {
  status: 'archived' | 'partial' | 'skipped';
  note?: string;
  archive?: CatalogArchive;
}

interface QueuedArchive {
  key: string;
  attempts: number;
}

/** What a manual batch of archives did, one line per title. */
export interface ArchiveBatchReport {
  configured: boolean;
  results: string[];
}

export interface ArchiveDeps {
  config: AppConfig;
  catalog: Catalog;
  /** The Bunny client for the entry's account; undefined when it is gone. */
  client: (entry: CatalogEntry) => BunnyClient | undefined;
  /** The R2 destination. Undefined means nothing can be archived. */
  r2?: R2Client;
  /** Whether the operator has archiving switched on. */
  enabled?: () => boolean;
  /**
   * Whatever else has to happen to this title first. The server passes the
   * subtitle repair's `settled`, because deleting a video the repair is still
   * attaching captions to would throw that work away.
   */
  before?: (key: string) => Promise<void>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Copies finished titles into R2 and, once they verify, lets Bunny forget them.
 *
 * It has the same shape as the subtitle repair: `consider(entry)` is called from
 * the publish hook with the record a finished job just wrote, work runs one
 * title at a time, and a failure is retried a few minutes later rather than
 * reported and dropped. Nothing is persisted — the catalogue entry the archive
 * writes *is* the record of what happened.
 */
export class ArchiveService {
  private deps: ArchiveDeps;
  private queue: QueuedArchive[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Keys queued, waiting on a retry, or in flight — never two of them at once. */
  private active = new Set<string>();
  private draining: Promise<void> | undefined;
  private stopped = false;
  private logLine: (message: string) => void;

  constructor(deps: ArchiveDeps) {
    this.deps = deps;
    this.logLine = deps.log ?? ((message) => console.log(message));
  }

  /** Whether an R2 destination is configured at all. */
  get configured(): boolean {
    return this.deps.r2 !== undefined && this.deps.config.r2 !== undefined;
  }

  private get prefix(): string {
    return this.deps.config.r2?.prefix ?? 'archive';
  }

  /**
   * Whether this entry still has something to archive: a Bunny video, an
   * account whose pull zone can be read, and no finished archive of that same
   * video (a republish makes a new video and so deserves a new archive).
   */
  eligible(entry: CatalogEntry): boolean {
    if (!entry.videoId || !entry.accountId) return false;
    if (!pullZoneBase(entry.pullZoneHost)) return false;
    return !(entry.archive?.complete && entry.archive.videoId === entry.videoId);
  }

  /** What the Library asks before offering an archive: which titles are left. */
  preview(): { configured: boolean; enabled: boolean; candidates: Array<{ key: string; title: string; kind: string; videoId?: string }> } {
    const candidates = this.deps.catalog
      .all()
      .filter((entry) => this.eligible(entry))
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        kind: entry.kind,
        ...(entry.videoId ? { videoId: entry.videoId } : {}),
      }));
    return { configured: this.configured, enabled: this.enabled(), candidates };
  }

  enabled(): boolean {
    return this.configured && (this.deps.enabled?.() ?? true);
  }

  /**
   * Called with the catalogue entry a finished job wrote. Queues an archive when
   * there is one to do, and says so; returns false when there is not (nothing to
   * archive, no destination, or the title is already queued).
   */
  consider(entry: CatalogEntry): boolean {
    if (this.stopped) return false;
    if (!this.enabled()) return false;
    if (!this.eligible(entry)) return false;
    if (this.active.has(entry.key)) return false;
    this.active.add(entry.key);
    this.queue.push({ key: entry.key, attempts: 0 });
    this.logLine(`[archive] ${entry.key} finished encoding — copying it to R2 before Bunny lets it go`);
    void this.drain();
    return true;
  }

  /**
   * Archives the given keys now and reports what happened to each.
   *
   * The manual path: same worker as the automatic one, run one key at a time so
   * a batch cannot open a dozen multi-gigabyte downloads at once.
   */
  async archiveKeys(keys: string[], limit = 25): Promise<ArchiveBatchReport> {
    if (!this.configured) return { configured: false, results: [] };
    const wanted = keys.length ? keys : this.preview().candidates.map((candidate) => candidate.key);
    const results: string[] = [];
    for (const key of wanted.slice(0, Math.max(1, limit))) {
      const entry = this.deps.catalog.get(key);
      if (!entry) {
        results.push(`${key}: no such catalogue entry`);
        continue;
      }
      if (this.active.has(key)) {
        results.push(`${key}: already archiving`);
        continue;
      }
      // An explicit click is not retried: the operator is watching, and the
      // reason belongs on screen rather than in a queue five minutes from now.
      const outcome = await this.execute(entry, this.budget);
      results.push(`${key}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ''}`);
    }
    return { configured: true, results };
  }

  /** Runs the queue to completion, one title at a time. */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const item = this.queue.shift();
        if (!item) break;
        await this.execute(this.deps.catalog.get(item.key), item.attempts + 1);
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /**
   * One title's archive, with its retries.
   *
   * A skip is terminal — there is no video, no account, no pull zone, nothing to
   * download — because none of those improve by waiting. A failure is not: the
   * destination may simply have been unreachable, so it is tried again after a
   * pause, and after the budget it is logged and forgotten.
   */
  private async execute(entry: CatalogEntry | undefined, attempt: number): Promise<ArchiveOutcome> {
    if (!entry) return { status: 'skipped', note: 'the catalogue no longer has this title' };
    this.active.add(entry.key);
    try {
      const outcome = await this.archive(entry);
      if (outcome.status === 'skipped') {
        this.active.delete(entry.key);
        this.logLine(`[archive] ${entry.key}: nothing to do — ${outcome.note ?? 'skipped'}`);
        return outcome;
      }
      if (outcome.status === 'archived') {
        this.active.delete(entry.key);
        const archive = outcome.archive;
        this.logLine(
          `[archive] ${entry.key}: ${archive?.objects.length ?? 0} object(s), ${Math.round((archive?.bytes ?? 0) / 1_048_576)} MB — ${archive?.removedFromBunny ? 'removed from Bunny' : 'Bunny still holds it'}`,
        );
        return outcome;
      }
      return this.retryOrGiveUp(entry.key, outcome.note ?? 'it did not finish', attempt);
    } catch (error) {
      return this.retryOrGiveUp(entry.key, describeError(error), attempt);
    }
  }

  /**
   * A failure waits a while and tries again — a CDN or a bucket that refused
   * once is very often answering a minute later. After the budget the title is
   * logged and dropped; Bunny still holds the video, which is the safe outcome.
   */
  private retryOrGiveUp(key: string, reason: string, attempt: number): ArchiveOutcome {
    if (attempt >= this.budget) {
      this.active.delete(key);
      this.logLine(`[archive] ${key}: gave up after ${attempt} attempt(s) — ${reason}`);
      return { status: 'partial', note: reason };
    }
    const waitMs = this.retryDelay(attempt);
    this.logLine(`[archive] ${key}: ${reason} — trying again in ${Math.round(waitMs / 1000)} s`);
    this.schedule({ key, attempts: attempt }, waitMs);
    return { status: 'partial', note: `${reason} (retrying)` };
  }

  private get budget(): number {
    return Math.max(1, Math.floor(this.deps.maxAttempts ?? ARCHIVE_ATTEMPTS));
  }

  private retryDelay(attempts: number): number {
    const base = Math.max(0, this.deps.retryDelayMs ?? ARCHIVE_RETRY_MS);
    return base * 2 ** Math.max(0, attempts - 1);
  }

  private schedule(item: QueuedArchive, waitMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(item.key);
      if (this.stopped) return;
      this.queue.push(item);
      void this.drain();
    }, waitMs);
    timer.unref?.();
    this.timers.set(item.key, timer);
  }

  /* ---------------------------------------------------------------- */
  /* The work itself                                                   */
  /* ---------------------------------------------------------------- */

  private async archive(entry: CatalogEntry): Promise<ArchiveOutcome> {
    const config = this.deps.config.r2;
    const r2 = this.deps.r2;
    if (!config || !r2) return { status: 'skipped', note: 'no R2 destination is configured' };
    if (!entry.videoId) return { status: 'skipped', note: 'the catalogue entry has no Bunny video' };
    const base = pullZoneBase(entry.pullZoneHost);
    if (!base) return { status: 'skipped', note: 'the account has no pull-zone hostname, so its files cannot be fetched' };
    const client = this.deps.client(entry);
    if (!client) return { status: 'skipped', note: 'the account that owns this video is gone' };

    // Whatever else is still working on this title (the subtitle repair) gets to
    // finish first: the archive is the last thing that happens to a title.
    await this.deps.before?.(entry.key).catch(() => undefined);

    const video = await client.getVideo(entry.videoId);
    if (mapBunnyStatus(video.status) !== 'ready') {
      return { status: 'skipped', note: `Bunny has not finished with it (${video.status})` };
    }

    const folder = archiveFolder(config.prefix, entry);
    const captions = captionLanguages(entry, video);
    const planned = planAssets(video, base, captions);
    const objects: CatalogArchiveObject[] = [];
    let bytes = 0;
    let videoBytes = 0;
    let videos = 0;

    for (const asset of planned) {
      const stored = await this.store(asset, `${folder}/${asset.name}`);
      if (!stored) continue;
      objects.push(stored);
      bytes += stored.bytes;
      if (stored.kind === 'video') {
        videoBytes += stored.bytes;
        videos += 1;
      }
    }

    // The player's seek sprites: numbered from `_0.jpg`, however many Bunny
    // generated, so they are probed until the first one that is not there.
    for (let index = 0; index < MAX_SEEK_SPRITES; index += 1) {
      const url = seekSpriteUrl(base, entry.videoId, index);
      const stored = await this.store(
        { name: `sprites/seek_${index}.jpg`, kind: 'sprite', url, contentType: 'image/jpeg' },
        `${folder}/sprites/seek_${index}.jpg`,
      );
      if (!stored) break;
      objects.push(stored);
      bytes += stored.bytes;
    }

    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const note = videos === 0 ? 'no MP4 rendition could be downloaded — enable MP4 Fallback on the Bunny library, or the video has no finished renditions' : undefined;

    const archive: CatalogArchive = {
      bucket: config.bucket,
      prefix: folder,
      ...(config.publicBase ? { base: R2Client.publicUrl(config.publicBase, folder) } : {}),
      objects,
      manifestKey: `${folder}/manifest.json`,
      bytes,
      videoBytes,
      videos,
      complete: false,
      ...(note ? { note } : {}),
      videoId: entry.videoId,
      ...(entry.playbackUrl ? { bunnyPlaybackUrl: entry.playbackUrl } : {}),
      ...(config.publicBase ? { playbackUrl: R2Client.publicUrl(config.publicBase, `${folder}/hls/playlist.m3u8`) } : {}),
      removedFromBunny: false,
      at: now,
    };

    // Nothing to play means nothing worth deleting: a folder of stills is not a
    // replacement for the video, and Bunny is still the only copy of it. This is
    // terminal rather than retried — an MP4 Fallback that is switched off in the
    // library does not switch itself on.
    if (videos === 0) {
      this.writeRecord(entry.key, archive);
      return { status: 'skipped', note: note ?? 'no MP4 rendition was available', archive };
    }

    // The manifest is written last, so its presence is what a complete archive
    // means. It is also the index a later reader checks the folder against.
    const manifest = {
      version: 1,
      key: entry.key,
      kind: entry.kind,
      tmdbId: entry.tmdbId,
      title: entry.title,
      ...(entry.year ? { year: entry.year } : {}),
      ...(entry.kind === 'episode' ? { season: entry.season ?? null, episode: entry.episode ?? null, episodeTitle: entry.episodeTitle ?? null } : {}),
      bunny: {
        accountId: entry.accountId ?? null,
        libraryId: entry.libraryId ?? null,
        videoId: entry.videoId,
        playbackUrl: entry.playbackUrl ?? null,
        resolutions: video.availableResolutions ?? null,
      },
      archivedAt: now,
      bucket: config.bucket,
      prefix: folder,
      base: archive.base ?? null,
      bytes,
      videoBytes,
      videos,
      objects,
    };
    const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await r2.put(archive.manifestKey, manifestBody, { contentType: 'application/json' });
    const manifestHead = await r2.head(archive.manifestKey);
    if (!manifestHead || manifestHead.bytes !== manifestBody.length) {
      throw new Error(`the manifest did not verify in R2 (${archive.manifestKey})`);
    }
    archive.complete = true;

    if (!config.keepBunny) {
      try {
        await client.deleteVideo(entry.videoId);
        archive.removedFromBunny = true;
        archive.removedAt = (this.deps.now?.() ?? new Date()).toISOString();
      } catch (error) {
        // The copy is safe either way; Bunny keeping the video is a warning, not
        // a lost archive.
        const reason = describeError(error);
        archive.note = note ? `${note}; Bunny still holds the video — ${reason}` : `Bunny still holds the video — ${reason}`;
        this.logLine(`[archive] ${entry.key}: the copy is complete but Bunny refused to delete the video — ${reason}`);
      }
    }

    this.writeRecord(entry.key, archive);
    return { status: 'archived', archive };
  }

  /** Writes the archive onto the catalogue entry, and never fails the run for it. */
  private writeRecord(key: string, archive: CatalogArchive): void {
    try {
      this.deps.catalog.setArchive(key, archive);
    } catch (error) {
      this.logLine(`[archive] could not record the archive of ${key}: ${describeError(error)}`);
    }
  }

  /**
   * One asset: look it up, stream it into R2 once, and confirm it landed.
   *
   * The HEAD comes first so a missing asset is a skip rather than a failed
   * download, and so R2 is told the length up front (which is what lets a big
   * file become a real multipart upload instead of a buffered PUT). The HEAD
   * against R2 afterwards is the verification: the archive only counts objects
   * the bucket itself says are there, at the size that was uploaded.
   */
  private async store(asset: PlannedAsset, key: string): Promise<CatalogArchiveObject | undefined> {
    const r2 = this.deps.r2;
    if (!r2) return undefined;
    const size = await this.assetSize(asset.url);
    if (size === null) return undefined;

    const upstream = await fetchWithPolicy(
      asset.url,
      { method: 'GET' },
      { what: 'the Bunny pull zone', fetchImpl: this.deps.fetchImpl ?? fetch, timeoutMs: ASSET_TIMEOUT_MS, retries: 2, backoffMs: 1_000 },
    );
    const body = upstream.body;
    if (!upstream.ok || !body) {
      await body?.cancel().catch(() => undefined);
      throw new Error(`the pull zone answered HTTP ${upstream.status} for ${asset.name}`);
    }

    let upload: R2UploadResult;
    try {
      upload = await r2.put(key, chunksOf(body), {
        contentType: asset.contentType,
        ...(size !== undefined ? { contentLength: size } : {}),
      });
    } catch (error) {
      // Give the download back rather than leaving it half-read on a socket.
      await body.cancel().catch(() => undefined);
      throw error;
    }
    if (size !== undefined && upload.bytes !== size) {
      throw new Error(`${asset.name} uploaded ${upload.bytes} bytes but the pull zone declared ${size}`);
    }
    const stored = await r2.head(key);
    if (!stored || stored.bytes === undefined || stored.bytes !== upload.bytes) {
      throw new Error(`${asset.name} did not verify in R2 (${key})`);
    }

    return { name: asset.name, key, kind: asset.kind, bytes: upload.bytes, sha256: upload.sha256, contentType: asset.contentType, source: asset.url };
  }

  /**
   * The asset's size, or `null` when it is not there at all.
   *
   * `undefined` means "there, but the size was not reported" — a HEAD the CDN
   * refused to answer (405) is not the same as an asset that does not exist, so
   * the download is still attempted and R2 simply buffers it.
   */
  private async assetSize(url: string): Promise<number | undefined | null> {
    // A transport failure is deliberately *not* caught here: an unreachable pull
    // zone is not an asset that does not exist, and treating it as one would
    // archive a folder of nothing and then delete the video.
    const response = await fetchWithPolicy(
      url,
      { method: 'HEAD' },
      { what: 'the Bunny pull zone', fetchImpl: this.deps.fetchImpl ?? fetch, timeoutMs: ASSET_HEAD_TIMEOUT_MS, retries: 1, backoffMs: 500 },
    );
    if (response.status === 404 || response.status === 403) return null;
    if (response.status === 405 || response.status === 501) return undefined;
    if (!response.ok) throw new Error(`the pull zone answered HTTP ${response.status} while measuring an asset`);
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    return Number.isFinite(length) ? length : undefined;
  }

  /** Resolves once nothing is queued, in flight or waiting on a retry. */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.draining || this.queue.length > 0 || this.timers.size > 0) {
      if (Date.now() > deadline) throw new Error(`the archive queue was still busy after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** Stops the queue and forgets pending retries. Nothing already archived is undone. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
  }
}

/** A web `ReadableStream`, as the chunk stream the R2 client uploads from. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncIterable<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock?.();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
