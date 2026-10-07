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
 * A title is a *task*, not a request. Moving several gigabytes takes minutes, so
 * nothing here runs inside an HTTP call: `enqueue` puts a title in line and
 * returns immediately, one title is worked on at a time, and every stage, byte
 * and object count is published as `ArchiveTask` updates that the server streams
 * to the browser. The task state is deliberately in memory — it describes work
 * in progress, and a restart simply means the title is offered again — while
 * what actually happened is written to the catalogue entry at the end.
 *
 * Each task walks five stages a UI can name: `checking` (read the video back
 * from Bunny), `scanning` (HEAD every asset to measure the job), `uploading`
 * (download, upload and verify one asset at a time, in bytes), `manifest`
 * (write the index last) and `deleting` (let Bunny forget it).
 *
 * The same queue also carries two operations that work *on* an archive rather
 * than building one, because a folder of several gigabytes cannot be checked or
 * put back inside a request either:
 *
 *   verify    re-reads `manifest.json` from the bucket and re-hashes every
 *             object it lists, so "is the copy still intact?" is answered by the
 *             bytes themselves rather than by a HEAD that only proves they exist
 *   restore   streams the archived rendition back out of R2 into a fresh Bunny
 *             video, re-attaches the captions, and points the catalogue at it —
 *             one pass of bytes with nothing on disk in between, so putting a
 *             title back needs no free space on this machine at all
 *
 * A task therefore carries an `operation`, and the stages it walks depend on it:
 * an archive ends in `deleting`, a verify in `verifying`, a restore in
 * `downloading` then `uploading` (into Bunny), and a repair in `repairing`.
 *
 * A repair is deliberately narrow. It never re-archives the title: it takes the
 * objects a verification pass flagged, fetches each one again from the pull zone
 * it came from, and only overwrites the stored object once the fresh bytes hash
 * to exactly what the manifest recorded. When Bunny no longer holds the video,
 * there is nothing to fetch from — so the repair falls back to what the bucket
 * still has: playback moves to the tallest *intact* rendition, the objects
 * nothing can supply are dropped from the record, and the manifest is rewritten
 * so the folder matches the bucket again. What was lost is recorded, never
 * quietly forgotten.
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bunnyAssets, mapBunnyStatus, MAX_SEEK_SPRITES, playbackUrlFor, pullZoneBase, seekSpriteUrl, type BunnyClient, type BunnyVideo } from './bunny';
import type { Catalog, CatalogArchive, CatalogArchiveObject, CatalogEntry } from './catalog';
import type { AppConfig } from './config';
import { fetchWithPolicy } from './net';
import { clampPresignExpiry, R2Client, type R2UploadResult } from './r2';
import type { TusSource } from './tus';

/** How long one asset download may take: a feature-length MP4 can be big. */
const ASSET_TIMEOUT_MS = 30 * 60_000;

/** The control-plane ceiling for a HEAD against the pull zone. */
const ASSET_HEAD_TIMEOUT_MS = 30_000;

/** Attempts for one title before the queue gives up and leaves Bunny alone. */
export const ARCHIVE_ATTEMPTS = 3;

/** The wait before the next attempt, doubled each time (a CDN hiccup clears). */
export const ARCHIVE_RETRY_MS = 5 * 60_000;

/** How many finished tasks the dashboard keeps around to show. */
const FINISHED_TASKS_KEPT = 50;

/** One file planned for the archive, before anything has been uploaded. */
export interface PlannedAsset {
  /** Where it goes inside the title's folder, e.g. `video/1080p.mp4`. */
  name: string;
  kind: CatalogArchiveObject['kind'];
  /** The pull-zone URL to download it from. */
  url: string;
  contentType: string;
}

/** A planned asset that was found on the pull zone, with the size it declared. */
export interface ProbedAsset extends PlannedAsset {
  /** `undefined` when the CDN would not answer a HEAD with a length. */
  bytes?: number;
}

/**
 * Where a title's archive has got to.
 *
 * `status` is the queue state and `stage` is what is happening inside it, kept
 * apart because a task waiting out a retry is *queued* (it will run again) while
 * being at no stage in particular.
 */
export type ArchiveStatus = 'queued' | 'active' | 'done' | 'failed' | 'skipped';

export type ArchiveStage =
  | 'queued'
  | 'checking'
  | 'scanning'
  | 'uploading'
  | 'manifest'
  | 'deleting'
  | 'verifying'
  | 'downloading'
  | 'repairing'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * What a task is doing: building an archive, checking one, putting one back, or
 * mending the objects a check found broken. All four move files across the same
 * two hosts, so they share one queue, one task shape and one stream.
 */
export type ArchiveOperation = 'archive' | 'verify' | 'restore' | 'repair';

/**
 * What one pass over the titles Bunny still holds did.
 *
 * `removed` is what it took out; `failed` is what Bunny refused again, which the
 * next pass tries once more; `skipped` counts entries whose account is gone, so
 * there is nobody left to delete the video with.
 */
export interface ArchiveRemovalReport {
  attempted: number;
  removed: string[];
  failed: Array<{ key: string; error: string }>;
  skipped: number;
}

export type ArchiveTaskChange = 'added' | 'updated' | 'removed';

/** One title's archive, as the queue and the browser see it. */
export interface ArchiveTask {
  /** The catalogue key, which is what every update is addressed by. */
  key: string;
  /** A readable name, so a progress row needs no second lookup. */
  title: string;
  kind: 'movie' | 'episode';
  /** Whether this task copies out, checks, or puts back. */
  operation: ArchiveOperation;
  status: ArchiveStatus;
  stage: ArchiveStage;
  /** The asset being moved right now, e.g. `video/1080p.mp4`. */
  asset?: string;
  /** How many assets the scan found, and how many are already stored. */
  assets: number;
  stored: number;
  /** Bytes handed to R2 so far, against the size of the whole plan. */
  bytes: number;
  totalBytes: number;
  percent: number;
  /** How many times this title has been attempted. */
  attempts: number;
  /** For a queued task: its place in line (1 = next to run). */
  position?: number;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  /** Why it stopped short, or what it is waiting for. */
  note?: string;
  /** The failure that ended it, when one did. */
  error?: string;
  removedFromBunny?: boolean;
  /** For a verify: how many objects have been re-read and hashed so far. */
  checked?: number;
  /** For a verify: the objects the pass found missing or changed. */
  bad?: string[];
  /** For a restore: the Bunny video it put the title back into. */
  restoredVideoId?: string;
  /** For a repair: the objects it rewrote in the bucket, from Bunny. */
  repaired?: string[];
  /** For a repair: the objects nothing could supply, dropped from the record. */
  dropped?: string[];
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

/** A readable label for a title, used for progress rows and log lines. */
export function archiveLabel(entry: CatalogEntry): string {
  if (entry.kind === 'episode') return `${entry.title} S${pad(entry.season)}E${pad(entry.episode)}`;
  return `${entry.title}${entry.year ? ` (${entry.year})` : ''}`;
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
 * anywhere, so they are discovered by probing (`seekSpriteUrl`) rather than
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

/**
 * The height named at the end of a rendition key (`video/1080p.mp4` → 1080).
 * Used to put the best rendition back first; an unreadable name sorts last.
 */
function renditionHeight(name: string): number {
  const match = /(\d{3,4})p?\.[a-z0-9]+$/i.exec(name);
  const height = Number(match?.[1] ?? Number.NaN);
  return Number.isFinite(height) ? height : 0;
}

/**
 * The archived file that *is* the title: the one a restore uploads back into
 * Bunny and the one the dashboard streams for playback.
 *
 * The MP4 renditions are preferred, tallest first: they are the encoded video
 * Bunny itself produced, so they play directly and put back without a second
 * transcode pass being the only copy. `original` is the fallback for an archive
 * whose renditions are gone, and `undefined` means there is nothing to play at
 * all — a folder of thumbnails is neither a restorable title nor a playable one.
 */
export function playableObject(objects: CatalogArchiveObject[] | undefined): CatalogArchiveObject | undefined {
  const videos = (objects ?? []).filter((object) => object.kind === 'video');
  if (videos.length) return [...videos].sort((a, b) => renditionHeight(b.name) - renditionHeight(a.name))[0];
  return (objects ?? []).find((object) => object.kind === 'original');
}

/**
 * The best intact copy left in the folder: the tallest object that is *not* one
 * of the ones a check flagged.
 *
 * This is what a repair falls back to when Bunny no longer holds the video — a
 * title whose 1080p rendition rotted can still play from its 720p neighbour,
 * which is a real repair rather than a note about one.
 */
export function intactPlayableObject(objects: CatalogArchiveObject[] | undefined, flagged: ReadonlySet<string>): CatalogArchiveObject | undefined {
  return playableObject((objects ?? []).filter((object) => !flagged.has(object.name)));
}

/** The names a verification pass flagged as missing or changed. */
export function flaggedObjects(verify: CatalogArchive['verify'] | undefined): string[] {
  if (!verify) return [];
  return [...new Set([...(verify.missing ?? []), ...(verify.mismatched ?? [])])];
}

/**
 * The dashboard's own route for an archived title's playback.
 *
 * Relative on purpose: the record is data, and the dashboard may be reached on
 * any hostname. What that route answers with is a fresh signed URL, so this link
 * never carries a credential and never expires.
 */
export function playbackRoute(key: string): string {
  return `/api/archive/play/${encodeURIComponent(key)}`;
}

/** The language code inside a stored caption key (`subtitles/en.vtt` → `en`). */
export function captionLanguage(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base.replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase() || base.toLowerCase();
}

/** One sentence describing a verification pass, for a task note and a log line. */
function verifyNote(verify: NonNullable<CatalogArchive['verify']>): string {
  if (verify.ok) return `every one of ${verify.checked} object(s) still hashes to what the manifest recorded`;
  const parts: string[] = [];
  if (verify.missing.length) parts.push(`${verify.missing.length} missing (${verify.missing.slice(0, 3).join(', ')})`);
  if (verify.mismatched.length) parts.push(`${verify.mismatched.length} changed (${verify.mismatched.slice(0, 3).join(', ')})`);
  return `${verify.checked} object(s) checked — ${parts.join('; ')}`;
}

export interface ArchiveOutcome {
  /** `ok` finished the job, `partial` failed, `skipped` never had anything to do. */
  status: 'ok' | 'partial' | 'skipped';
  note?: string;
  archive?: CatalogArchive;
  /** The Bunny video a restore created. */
  videoId?: string;
}

interface QueuedArchive {
  key: string;
  attempts: number;
  /** Whether a failure is tried again (`false` for a titled clicked by hand). */
  retry: boolean;
  operation: ArchiveOperation;
}

/** One title the Library may offer for an operation, without doing any work. */
export interface ArchiveCandidate {
  key: string;
  title: string;
  kind: string;
  videoId?: string;
  /** For a verification candidate: how many objects its manifest lists. */
  objects?: number;
  bytes?: number;
  verifiedAt?: string;
  /** For a verification candidate: what the last pass found. */
  verified?: boolean;
  restoredAt?: string;
  /** For a repair candidate: whether Bunny still holds the video to re-fetch from. */
  fromBunny?: boolean;
  /** For a repair candidate: the intact rendition playback would move onto. */
  switchedTo?: string;
}

/** What a manual batch did, one line per title. */
export interface ArchiveBatchReport {
  configured: boolean;
  results: string[];
}

/** What a manual batch queued, before any of it has run. */
export interface ArchiveEnqueueReport {
  configured: boolean;
  queued: ArchiveTask[];
  skipped: Array<{ key: string; reason: string }>;
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

/** The bytes of a plan that are known: an unmeasurable asset counts as zero. */
function planBytes(assets: ProbedAsset[]): number {
  return assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
}

function percentOf(task: ArchiveTask): number {
  if (task.status === 'done') return 100;
  if (task.totalBytes <= 0) return 0;
  // 99 until it is actually done: a plan whose sizes were partly unreported must
  // never read as finished while a byte is still moving.
  return Math.max(0, Math.min(99, Math.round((task.bytes / task.totalBytes) * 100)));
}

/**
 * Copies finished titles into R2 and, once they verify, lets Bunny forget them.
 *
 * It has the same shape as the subtitle repair: `consider(entry)` is called from
 * the publish hook with the record a finished job just wrote, work runs one
 * title at a time, and a failure is retried a few minutes later rather than
 * reported and dropped. What it adds is that every title is a *task* with a
 * status and a byte count, published to listeners as it moves, so a browser can
 * watch gigabytes move without anything being held open.
 */
export class ArchiveService {
  private deps: ArchiveDeps;
  private queue: QueuedArchive[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Keys queued, waiting on a retry, or in flight — never two of them at once. */
  private active = new Set<string>();
  /** Every task the dashboard knows about, by catalogue key. */
  private tasks = new Map<string, ArchiveTask>();
  private listeners = new Set<(task: ArchiveTask, change: ArchiveTaskChange) => void>();
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

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /* ---------------------------------------------------------------- */
  /* Task state                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Watch the queue, the way the store's own change hook is watched.
   *
   * The live event stream is the subscriber: it is told *which* title moved, so
   * it can push that one row instead of the browser re-reading everything.
   */
  onTaskChange(listener: (task: ArchiveTask, change: ArchiveTaskChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A listener that throws must never be able to break an archive. */
  private notify(task: ArchiveTask, change: ArchiveTaskChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(task, change);
      } catch (error) {
        console.error('[archive] a task listener failed:', error);
      }
    }
  }

  /** Every task, most recently moved first. */
  list(): ArchiveTask[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  task(key: string): ArchiveTask | undefined {
    return this.tasks.get(key);
  }

  /** How many titles are queued or moving — the "N archiving" in the Library. */
  get busy(): number {
    return [...this.tasks.values()].filter((task) => task.status === 'queued' || task.status === 'active').length;
  }

  /** Records a patch and publishes it. */
  private touch(task: ArchiveTask, patch: Partial<ArchiveTask> = {}, change: ArchiveTaskChange = 'updated'): ArchiveTask {
    Object.assign(task, patch, { updatedAt: this.nowIso() });
    task.percent = percentOf(task);
    if (task.status === 'queued') task.position = Math.max(1, this.queue.findIndex((item) => item.key === task.key) + 1) || undefined;
    else task.position = undefined;
    this.tasks.set(task.key, task);
    this.prune();
    this.notify(task, change);
    return task;
  }

  private createTask(entry: CatalogEntry, operation: ArchiveOperation): ArchiveTask {
    const task: ArchiveTask = {
      key: entry.key,
      title: archiveLabel(entry),
      kind: entry.kind,
      operation,
      status: 'queued',
      stage: 'queued',
      assets: 0,
      stored: 0,
      bytes: 0,
      totalBytes: 0,
      percent: 0,
      attempts: 0,
      updatedAt: this.nowIso(),
    };
    this.tasks.set(entry.key, task);
    return task;
  }

  /** Keeps the finished tasks from growing without bound over a long run. */
  private prune(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.status === 'done' || task.status === 'failed' || task.status === 'skipped')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const task of finished.slice(FINISHED_TASKS_KEPT)) {
      this.tasks.delete(task.key);
      this.notify(task, 'removed');
    }
  }

  /* ---------------------------------------------------------------- */
  /* The queue                                                        */
  /* ---------------------------------------------------------------- */

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

  /**
   * Whether this entry has an archive worth re-reading: a manifest to check
   * against and objects listed inside it.
   */
  verifyEligible(entry: CatalogEntry): boolean {
    return Boolean(entry.archive?.manifestKey && (entry.archive.objects?.length ?? 0) > 0);
  }

  /**
   * Whether this entry can be put back: an archived rendition to upload, and an
   * account that is still in the store to upload it into.
   */
  restoreEligible(entry: CatalogEntry): boolean {
    if (!entry.archive || !playableObject(entry.archive.objects)) return false;
    return this.deps.client(entry) !== undefined;
  }

  /**
   * Whether this entry has something to mend: a check that failed, naming at
   * least one object.
   *
   * A repair is only ever offered *because* a verification pass found something
   * wrong, so there is no guessing about what needs mending — the flagged names
   * are the work list, and the manifest says what each one should be.
   */
  repairEligible(entry: CatalogEntry): boolean {
    if (!entry.archive) return false;
    return entry.archive.verify?.ok === false && flaggedObjects(entry.archive.verify).length > 0;
  }

  /**
   * What the Library asks before offering an archive: which titles are left.
   *
   * Oldest publication first, which is the order a backlog should be worked in
   * — the title that has been waiting longest is the one still sitting in Bunny
   * (and paying for itself there) for the longest. The automatic sweep takes the
   * same list, so a library larger than one batch drains in the order it
   * accumulated rather than newest first.
   */
  preview(): { configured: boolean; enabled: boolean; candidates: ArchiveCandidate[] } {
    const candidates = this.deps.catalog
      .all()
      .sort((a, b) => a.firstPublishedAt.localeCompare(b.firstPublishedAt))
      .filter((entry) => this.eligible(entry))
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        kind: entry.kind,
        ...(entry.videoId ? { videoId: entry.videoId } : {}),
      }));
    return { configured: this.configured, enabled: this.enabled(), candidates };
  }

  /** What is in R2 and could be re-checked, with what the last pass found. */
  verifyCandidates(): ArchiveCandidate[] {
    return this.deps.catalog
      .all()
      .filter((entry) => this.verifyEligible(entry))
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        kind: entry.kind,
        objects: entry.archive?.objects.length ?? 0,
        bytes: entry.archive?.bytes ?? 0,
        ...(entry.archive?.verifiedAt ? { verifiedAt: entry.archive.verifiedAt } : {}),
        ...(entry.archive?.verify ? { verified: entry.archive.verify.ok } : {}),
      }));
  }

  /**
   * Whether the record says Bunny still holds the video — the one place a broken
   * object's original bytes can come from.
   *
   * This is only what a *row* shows before it is pressed; the repair itself asks
   * Bunny, because the answer can have changed since the archive was written.
   */
  private stillInBunny(entry: CatalogEntry): boolean {
    return this.deps.client(entry) !== undefined && entry.archive?.removedFromBunny === false;
  }

  /** What a check found broken and could be mended, and by which route. */
  repairCandidates(): ArchiveCandidate[] {
    return this.deps.catalog
      .all()
      .filter((entry) => this.repairEligible(entry))
      .map((entry) => {
        const flagged = flaggedObjects(entry.archive?.verify);
        const fromBunny = this.stillInBunny(entry);
        const intact = intactPlayableObject(entry.archive?.objects, new Set(flagged));
        return {
          key: entry.key,
          title: entry.title,
          kind: entry.kind,
          // What a repair could do, so the row can say so before it is pressed.
          fromBunny,
          objects: flagged.length,
          ...(intact && flagged.includes(playableObject(entry.archive?.objects)?.name ?? '') ? { switchedTo: intact.name } : {}),
        };
      });
  }

  /** What could be put back into Bunny, and whether it already was. */
  restoreCandidates(): ArchiveCandidate[] {
    return this.deps.catalog
      .all()
      .filter((entry) => this.restoreEligible(entry))
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        kind: entry.kind,
        ...(entry.archive?.restoredAt ? { restoredAt: entry.archive.restoredAt } : {}),
      }));
  }

  /**
   * A short-lived signed URL that plays an archived title straight out of R2.
   *
   * The dashboard is the gatekeeper: the bucket stays private, the URL is minted
   * per request, and it stops working after `expiresIn` seconds (the configured
   * `R2_URL_TTL`, five minutes by default). `undefined` means there is nothing to
   * play — no destination, no archive, or a folder of stills with no rendition in
   * it.
   */
  media(
    entry: CatalogEntry | undefined,
    options: { expiresIn?: number } = {},
  ): { url: string; key: string; name: string; expiresIn: number } | undefined {
    const r2 = this.deps.r2;
    if (!r2 || !entry?.archive) return undefined;
    const object = playableObject(entry.archive.objects);
    if (!object) return undefined;
    const expiresIn = clampPresignExpiry(options.expiresIn ?? this.deps.config.r2?.urlTtl);
    return { url: r2.presign(object.key, { expiresIn }), key: object.key, name: object.name, expiresIn };
  }

  enabled(): boolean {
    return this.configured && (this.deps.enabled?.() ?? true);
  }

  /** Whether this entry has anything to do for the given operation right now. */
  private eligibleFor(entry: CatalogEntry, operation: ArchiveOperation): boolean {
    if (operation === 'verify') return this.verifyEligible(entry);
    if (operation === 'restore') return this.restoreEligible(entry);
    if (operation === 'repair') return this.repairEligible(entry);
    return this.eligible(entry);
  }

  /**
   * Puts one title in line and returns at once. `retry` decides whether a
   * failure comes back round; an operator clicking a button is watching, so
   * their answer belongs on screen rather than in a queue five minutes later.
   *
   * `operation` picks the work — copy out, check, or put back. Only an archive
   * honours the operator's on/off switch: a verification or a restore acts on a
   * folder that is already there, so needing a destination is enough.
   */
  enqueue(entry: CatalogEntry, options: { retry?: boolean; operation?: ArchiveOperation } = {}): ArchiveTask | undefined {
    const operation = options.operation ?? 'archive';
    if (this.stopped) return undefined;
    if (!this.configured) return undefined;
    if (operation === 'archive' && !this.enabled()) return undefined;
    if (!this.eligibleFor(entry, operation)) return undefined;
    if (this.active.has(entry.key)) return undefined;
    this.active.add(entry.key);
    const task = this.createTask(entry, operation);
    this.touch(task, { stage: 'queued' }, 'added');
    this.queue.push({ key: entry.key, attempts: 0, retry: options.retry ?? true, operation });
    void this.drain();
    return task;
  }

  /**
   * Retries the Bunny deletes that did not happen.
   *
   * A copy that verified in R2 but whose `deleteVideo` failed leaves the worst
   * kind of leftover: the archive is complete and safe, the record says Bunny
   * "still holds the video", and nothing ever tries again — so the title keeps
   * its bytes in the library forever, which is exactly what the operator asked
   * not to happen. Only entries whose archive **completed** are considered, so
   * this can never take a video out of Bunny that is not already in the bucket,
   * and turning `R2_KEEP_BUNNY` off later means the copies made while it was on
   * are removed too — which is what the switch says.
   */
  async removeLeftovers(limit = 25): Promise<ArchiveRemovalReport> {
    const report: ArchiveRemovalReport = { attempted: 0, removed: [], failed: [], skipped: 0 };
    const config = this.deps.config.r2;
    if (!config || config.keepBunny) return report;
    const leftovers = this.deps.catalog
      .all()
      .filter((entry) => entry.archive?.complete === true && entry.archive.removedFromBunny !== true)
      .slice(0, Math.max(1, Math.floor(limit)));
    for (const entry of leftovers) {
      const previous = entry.archive;
      // Not reachable through the filter above, but it is what makes the record
      // below a copy of a real archive rather than of `undefined`.
      if (!previous) continue;
      // The video the *archive* was made of: after a republish the entry points
      // at a new one, and the old one is the copy that is already in R2.
      const videoId = previous.videoId ?? entry.videoId;
      const client = this.deps.client(entry);
      if (!videoId || !client) {
        report.skipped += 1;
        continue;
      }
      report.attempted += 1;
      try {
        await client.deleteVideo(videoId);
      } catch (error) {
        const reason = describeError(error);
        report.failed.push({ key: entry.key, error: reason });
        this.logLine(`[archive] ${entry.key}: Bunny still refuses to delete the video — ${reason}`);
        continue;
      }
      const archive: CatalogArchive = { ...previous, removedFromBunny: true, removedAt: this.nowIso() };
      delete archive.note;
      this.writeRecord(entry.key, archive);
      report.removed.push(entry.key);
    }
    return report;
  }

  /**
   * Called with the catalogue entry a finished job wrote. Queues an archive when
   * there is one to do, and says so; returns false when there is not (nothing to
   * archive, no destination, or the title is already queued).
   */
  consider(entry: CatalogEntry): boolean {
    const task = this.enqueue(entry, { retry: true });
    if (!task) return false;
    this.logLine(`[archive] ${entry.key} finished encoding — copying it to R2 before Bunny lets it go`);
    return true;
  }

  /** The keys a batch would walk when the caller did not name any. */
  private candidatesFor(operation: ArchiveOperation): ArchiveCandidate[] {
    if (operation === 'verify') return this.verifyCandidates();
    if (operation === 'restore') return this.restoreCandidates();
    if (operation === 'repair') return this.repairCandidates();
    return this.preview().candidates;
  }

  /** Why a title the operator named cannot be queued for this operation. */
  private skipReason(entry: CatalogEntry, operation: ArchiveOperation): string {
    if (operation === 'verify') return this.verifyEligible(entry) ? 'nothing to check' : 'this title has no archive to check';
    if (operation === 'restore') return this.restoreEligible(entry) ? 'nothing to restore' : 'nothing in R2 can be put back into Bunny';
    if (operation === 'repair') return this.repairEligible(entry) ? 'nothing to mend' : 'the last check on this title found nothing to mend';
    return this.enabled() ? 'nothing left to archive' : 'archiving is switched off';
  }

  /**
   * Queues the given keys — or the oldest candidates when none were given — and
   * answers immediately with what went into the queue and what did not.
   *
   * This is what the API calls: the work itself runs on the queue, so a click
   * that moves ten gigabytes does not hold a request open for an hour. The same
   * shape serves all three operations; only what the queue then does differs.
   */
  enqueueKeys(keys: string[], limit = 25, operation: ArchiveOperation = 'archive'): ArchiveEnqueueReport {
    if (!this.configured) return { configured: false, queued: [], skipped: [] };
    const wanted = keys.length ? keys : this.candidatesFor(operation).map((candidate) => candidate.key);
    const queued: ArchiveTask[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const key of wanted.slice(0, Math.max(1, limit))) {
      const entry = this.deps.catalog.get(key);
      if (!entry) {
        skipped.push({ key, reason: 'no such catalogue entry' });
        continue;
      }
      if (this.active.has(key)) {
        const busy =
          operation === 'archive' ? 'already archiving' : operation === 'verify' ? 'already checking this title' : operation === 'restore' ? 'already restoring this title' : 'already mending this title';
        skipped.push({ key, reason: busy });
        continue;
      }
      const task = this.enqueue(entry, { retry: false, operation });
      if (task) queued.push(task);
      else skipped.push({ key, reason: this.skipReason(entry, operation) });
    }
    return { configured: true, queued, skipped };
  }

  /**
   * Queues the given keys and waits for the queue to finish, answering one line
   * per title — the shape the tests use, and the shape a caller who genuinely
   * wants to block would want.
   */
  async archiveKeys(keys: string[], limit = 25, timeoutMs = 30 * 60_000): Promise<ArchiveBatchReport> {
    if (!this.configured) return { configured: false, results: [] };
    const report = this.enqueueKeys(keys, limit);
    const results = report.skipped.map((entry) => `${entry.key}: skipped — ${entry.reason}`);
    if (report.queued.length) {
      await this.idle(timeoutMs);
      for (const task of report.queued) {
        const settled = this.tasks.get(task.key) ?? task;
        const outcome = settled.status === 'done' ? 'archived' : settled.status === 'failed' ? 'partial' : 'skipped';
        results.push(`${settled.key}: ${outcome}${settled.note ? ` — ${settled.note}` : ''}`);
      }
    }
    return { configured: true, results };
  }

  /**
   * Runs the queue to completion, one title at a time.
   *
   * Every caller starts this as `void this.drain()`, so nothing it awaits may
   * reject: a floating rejection is an unhandled one, and Node ends the process
   * on it — killing every other upload with it. A title that throws is logged
   * and the queue moves on.
   */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const item = this.queue.shift();
        if (!item) break;
        try {
          await this.execute(this.deps.catalog.get(item.key), item);
        } catch (error) {
          this.active.delete(item.key);
          this.logLine(`[archive] ${item.key}: the task failed — ${describeError(error)}`);
        }
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
  private async execute(entry: CatalogEntry | undefined, item: QueuedArchive): Promise<ArchiveOutcome> {
    if (!entry) return { status: 'skipped', note: 'the catalogue no longer has this title' };
    const attempt = item.attempts + 1;
    this.active.add(entry.key);
    const task = this.tasks.get(entry.key) ?? this.createTask(entry, item.operation);
    // A retry starts the counters over: the bytes from the failed attempt were
    // not stored, and leaving them in would make the bar lie.
    this.touch(task, {
      operation: item.operation,
      status: 'active',
      stage: 'checking',
      asset: undefined,
      assets: 0,
      stored: 0,
      bytes: 0,
      totalBytes: 0,
      checked: undefined,
      bad: undefined,
      restoredVideoId: undefined,
      repaired: undefined,
      dropped: undefined,
      attempts: attempt,
      note: undefined,
      error: undefined,
      startedAt: task.startedAt ?? this.nowIso(),
      finishedAt: undefined,
    });

    try {
      const outcome =
        item.operation === 'verify'
          ? await this.verify(entry, task)
          : item.operation === 'restore'
            ? await this.restore(entry, task)
            : item.operation === 'repair'
              ? await this.repair(entry, task)
              : await this.archive(entry, task);
      if (outcome.status === 'skipped') {
        this.active.delete(entry.key);
        this.touch(task, { status: 'skipped', stage: 'skipped', note: outcome.note, finishedAt: this.nowIso(), asset: undefined });
        this.logLine(`[archive] ${entry.key}: nothing to do — ${outcome.note ?? 'skipped'}`);
        return outcome;
      }
      if (outcome.status === 'ok') {
        this.active.delete(entry.key);
        const archive = outcome.archive;
        this.touch(task, {
          status: 'done',
          stage: 'done',
          note: outcome.note,
          ...(item.operation === 'archive' ? { removedFromBunny: archive?.removedFromBunny } : {}),
          ...(outcome.videoId ? { restoredVideoId: outcome.videoId } : {}),
          finishedAt: this.nowIso(),
          asset: undefined,
        });
        this.logLine(this.finishedLine(entry.key, item.operation, task, outcome));
        return outcome;
      }
      return this.retryOrGiveUp(task, outcome.note ?? 'it did not finish', attempt, item.retry);
    } catch (error) {
      return this.retryOrGiveUp(task, describeError(error), attempt, item.retry);
    }
  }

  /** One log line per finished operation, because each one moved something different. */
  private finishedLine(key: string, operation: ArchiveOperation, task: ArchiveTask, outcome: ArchiveOutcome): string {
    if (operation === 'verify') {
      return `[archive] ${key}: checked ${task.checked ?? 0} object(s) — ${outcome.note ?? 'ok'}`;
    }
    if (operation === 'restore') {
      return `[archive] ${key}: put back into Bunny as ${outcome.videoId ?? 'a new video'} — ${outcome.note ?? 'ok'}`;
    }
    if (operation === 'repair') {
      return `[archive] ${key}: mended ${(task.repaired ?? []).length} object(s), dropped ${(task.dropped ?? []).length} — ${outcome.note ?? 'ok'}`;
    }
    const archive = outcome.archive;
    return `[archive] ${key}: ${archive?.objects.length ?? 0} object(s), ${Math.round((archive?.bytes ?? 0) / 1_048_576)} MB — ${
      archive?.removedFromBunny ? 'removed from Bunny' : 'Bunny still holds it'
    }`;
  }

  /**
   * A failure waits a while and tries again — a CDN or a bucket that refused
   * once is very often answering a minute later. After the budget the title is
   * logged and dropped; Bunny still holds the video, which is the safe outcome.
   */
  private retryOrGiveUp(task: ArchiveTask, reason: string, attempt: number, retry: boolean): ArchiveOutcome {
    if (!retry || attempt >= this.budget) {
      this.active.delete(task.key);
      this.touch(task, {
        status: 'failed',
        stage: 'failed',
        note: reason,
        error: reason,
        finishedAt: this.nowIso(),
        asset: undefined,
        // Only an archive has a Bunny copy to talk about; a failed check or mend
        // must not rewrite what the last archive run recorded.
        ...(task.operation === 'archive' ? { removedFromBunny: false } : {}),
      });
      this.logLine(`[archive] ${task.key}: gave up after ${attempt} attempt(s) — ${reason}`);
      return { status: 'partial', note: reason };
    }
    const waitMs = this.retryDelay(attempt);
    const nextIn = `trying again in ${Math.round(waitMs / 1000)} s`;
    this.logLine(`[archive] ${task.key}: ${reason} — ${nextIn}`);
    this.touch(task, {
      status: 'queued',
      stage: 'queued',
      note: `${reason} — ${nextIn}`,
      error: reason,
      asset: undefined,
    });
    this.schedule({ key: task.key, attempts: attempt, retry, operation: task.operation }, waitMs);
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

  private async archive(entry: CatalogEntry, task: ArchiveTask): Promise<ArchiveOutcome> {
    const config = this.deps.config.r2;
    const r2 = this.deps.r2;
    if (!config || !r2) return { status: 'skipped', note: 'no R2 destination is configured' };
    if (!entry.videoId) return { status: 'skipped', note: 'the catalogue entry has no Bunny video' };
    const base = pullZoneBase(entry.pullZoneHost);
    if (!base) return { status: 'skipped', note: 'the account has no pull-zone hostname, so its files cannot be fetched' };
    const client = this.deps.client(entry);
    if (!client) return { status: 'skipped', note: 'the account that owns this video is gone' };

    // Whatever else is still working on this title (the subtitle repair) gets to
    // finish first: the archive is the last thing that happens to a title, and
    // deleting the video while a caption upload is still in flight would throw
    // that translation away with the source it was read from.
    //
    // A wait that runs out (a rate-limited translator still retrying) stands the
    // attempt aside rather than continuing: the copy is not urgent enough to
    // cost the subtitle the operator asked to have filled in. The title stays a
    // candidate, and the sweep brings it back once the repair has settled.
    const busy = await Promise.resolve()
      .then(() => this.deps.before?.(entry.key))
      .then(() => undefined)
      .catch((error: unknown) => describeError(error));
    if (busy) {
      return { status: 'skipped', note: `still waiting for the subtitle work on this title — ${busy}` };
    }

    const video = await client.getVideo(entry.videoId);
    if (mapBunnyStatus(video.status) !== 'ready') {
      return { status: 'skipped', note: `Bunny has not finished with it (${video.status})` };
    }

    // Measure first. Every asset is HEAD-ed up front so the task knows what the
    // whole job is — that is what turns a bare spinner into "video/1080p.mp4,
    // 42% of 3.4 GB" — and so an unreachable pull zone fails before a single
    // byte has been copied.
    const folder = archiveFolder(config.prefix, entry);
    this.touch(task, { stage: 'scanning' });
    const assets = await this.scan(base, entry, video, task);

    const objects: CatalogArchiveObject[] = [];
    let bytes = 0;
    let videoBytes = 0;
    let videos = 0;
    for (const asset of assets) {
      this.touch(task, { stage: 'uploading', asset: asset.name, stored: objects.length, bytes, assets: assets.length, totalBytes: planBytes(assets) });
      const stored = await this.move(asset, `${folder}/${asset.name}`, task, bytes);
      objects.push(stored);
      bytes += stored.bytes;
      if (stored.kind === 'video') {
        videoBytes += stored.bytes;
        videos += 1;
      }
      this.touch(task, { stored: objects.length, bytes });
    }

    const now = this.nowIso();
    const note = videos === 0 ? 'no MP4 rendition could be downloaded — enable MP4 Fallback on the Bunny library, or the video has no finished renditions' : undefined;

    const media = playableObject(objects);
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
      // Playback moves to the dashboard, which signs a short-lived R2 URL for
      // every request: the bucket can stay private, a shared link cannot be
      // passed around forever, and the title still plays whether or not Bunny
      // was allowed to keep the video.
      ...(media ? { playbackUrl: playbackRoute(entry.key), mediaKey: media.key } : {}),
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
    this.touch(task, { stage: 'manifest', asset: 'manifest.json' });
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
      this.touch(task, { stage: 'deleting', asset: undefined });
      try {
        await client.deleteVideo(entry.videoId);
        archive.removedFromBunny = true;
        archive.removedAt = this.nowIso();
      } catch (error) {
        // The copy is safe either way; Bunny keeping the video is a warning, not
        // a lost archive.
        const reason = describeError(error);
        archive.note = note ? `${note}; Bunny still holds the video — ${reason}` : `Bunny still holds the video — ${reason}`;
        this.logLine(`[archive] ${entry.key}: the copy is complete but Bunny refused to delete the video — ${reason}`);
      }
    }

    this.writeRecord(entry.key, archive);
    return { status: 'ok', archive };
  }

  /**
   * Re-reads the manifest from the bucket and re-hashes every object it lists.
   *
   * A HEAD only proves an object is *there*; this downloads each one and compares
   * its SHA-256 and size to what the manifest recorded when it was written, which
   * is the only way to answer "is the copy still the copy?". The manifest is read
   * from R2 rather than from the catalogue so the check does not trust the same
   * local record it is checking, and a mismatch is reported rather than retried
   * away — the point is to find out, not to hide it.
   */
  private async verify(entry: CatalogEntry, task: ArchiveTask): Promise<ArchiveOutcome> {
    const r2 = this.deps.r2;
    const archive = entry.archive;
    if (!r2) return { status: 'skipped', note: 'no R2 destination is configured' };
    if (!archive) return { status: 'skipped', note: 'this title has no archive to check' };

    this.touch(task, { stage: 'checking' });
    const manifest = await this.readManifest(r2, archive.manifestKey);
    if (!manifest) {
      const at = this.nowIso();
      const verify = { at, ok: false, checked: 0, missing: [archive.manifestKey], mismatched: [] };
      this.recordVerify(entry.key, verify);
      this.touch(task, { bad: [archive.manifestKey] });
      return { status: 'partial', note: `the manifest is not in the bucket (${archive.manifestKey})`, archive: { ...archive, verify, verifiedAt: at } };
    }

    const objects = (manifest.objects ?? []).filter((object): object is CatalogArchiveObject => Boolean(object?.key));
    if (!objects.length) return { status: 'skipped', note: 'the manifest lists no objects to check' };

    this.touch(task, {
      stage: 'verifying',
      assets: objects.length,
      totalBytes: objects.reduce((total, object) => total + (object.bytes ?? 0), 0),
      stored: 0,
      bytes: 0,
      checked: 0,
    });

    const missing: string[] = [];
    const mismatched: string[] = [];
    let checkedCount = 0;
    let bytes = 0;
    for (const object of objects) {
      const name = object.name || object.key;
      const digest = await r2.read(object.key);
      if (!digest) missing.push(name);
      else if (digest.sha256 !== object.sha256 || (object.bytes !== undefined && digest.bytes !== object.bytes)) mismatched.push(name);
      else bytes += digest.bytes;
      checkedCount += 1;
      this.touch(task, { checked: checkedCount, stored: checkedCount, bytes, asset: name });
    }

    const at = this.nowIso();
    const ok = missing.length === 0 && mismatched.length === 0;
    const verify = { at, ok, checked: checkedCount, missing, mismatched };
    this.recordVerify(entry.key, verify);
    const note = verifyNote(verify);
    const updated = { ...archive, verify, verifiedAt: at };
    if (!ok) {
      this.touch(task, { bad: [...missing, ...mismatched], note });
      return { status: 'partial', note, archive: updated };
    }
    // An empty list, not an absent one: "this pass found nothing wrong" and "no
    // pass has run" are different answers, and the row shows the difference.
    this.touch(task, { bad: [] });
    return { status: 'ok', note, archive: updated };
  }

  /**
   * Puts an archived title back into Bunny.
   *
   * The best archived rendition streams out of R2 and straight into Bunny — one
   * pass of bytes through a running SHA-256, with no local copy at any point, so
   * a restore needs no free disk. The digest that pass produces is what decides
   * whether the object still is what the manifest recorded: because the bytes go
   * to Bunny while they are being hashed, a mismatch is caught *after* the fact
   * rather than before it, so the half-made video is deleted rather than left in
   * the library as a copy nothing vouched for.
   *
   * The R2 archive is left exactly where it is: a restore adds a copy rather than
   * moving one, so a title can be restored, and archived again, as often as it is
   * asked to.
   */
  private async restore(entry: CatalogEntry, task: ArchiveTask): Promise<ArchiveOutcome> {
    const r2 = this.deps.r2;
    const archive = entry.archive;
    if (!r2) return { status: 'skipped', note: 'no R2 destination is configured' };
    if (!archive) return { status: 'skipped', note: 'this title has no archive to restore from' };
    const client = this.deps.client(entry);
    if (!client) return { status: 'skipped', note: 'the account that would receive it is gone' };
    const source = playableObject(archive.objects);
    if (!source) return { status: 'skipped', note: 'the archive holds no rendition to put back' };

    // The bar counts both halves of the round trip — the bytes out of R2 and the
    // bytes back into Bunny — so it only reads 100% once the title is playable.
    // They now move at the same time, so the two counts are added as they arrive.
    const total = Math.max(1, source.bytes * 2);
    let read = 0;
    let sent = 0;
    const progress = (): void => {
      this.touch(task, { bytes: Math.min(total, read + sent) });
    };
    this.touch(task, { stage: 'downloading', asset: source.name, assets: 1, stored: 0, bytes: 0, totalBytes: total });

    // The bucket is asked for the object before Bunny is asked for a video: a
    // folder whose rendition is gone must fail the restore, not leave an empty
    // video behind.
    const rendition = await streamedObject(r2, source, (bytes) => {
      read = bytes;
      progress();
    });
    const title = archiveLabel(entry);
    let video: BunnyVideo | undefined;
    try {
      video = await client.createVideo(title);
      this.touch(task, { stage: 'uploading', asset: source.name, stored: 1 });
      await this.upload(client, video.guid, title, source, rendition, (bytesSent) => {
        sent = bytesSent;
        progress();
      });

      // A transport that answered without pulling the bytes (a mock Bunny, or a
      // PUT that was never written) leaves the digest short: finish the read so
      // the verdict is about the archive rather than about the transport.
      const digest = await rendition.finish();
      if (digest.bytes !== source.bytes) throw new Error(`${source.name} is ${digest.bytes} bytes, not the ${source.bytes} the archive recorded`);
      if (digest.sha256 !== source.sha256) throw new Error(`${source.name} no longer matches the archive (its SHA-256 changed)`);

      const failedCaptions = await this.reapplyCaptions(client, video.guid, entry, archive, r2);
      const at = this.nowIso();
      const playbackUrl = playbackUrlFor(entry.pullZoneHost, video.guid);
      this.writeRestore(entry.key, { videoId: video.guid, ...(playbackUrl ? { playbackUrl } : {}), ...(video.status !== undefined ? { bunnyStatus: video.status } : {}), at });
      const note = `back in Bunny as ${video.guid}${failedCaptions.length ? ` — ${failedCaptions.length} caption(s) could not be re-attached (${failedCaptions.join(', ')})` : ''}`;
      return { status: 'ok', note, videoId: video.guid };
    } catch (error) {
      // A half-uploaded copy would sit in the library with nothing playable — or
      // worse, with bytes nothing has vouched for: let Bunny forget it rather
      // than leave the shell behind.
      if (video) await client.deleteVideo(video.guid).catch(() => undefined);
      throw error;
    } finally {
      await rendition.close();
    }
  }

  /**
   * Mends the objects a verification pass flagged, then proves the mend.
   *
   * Each flagged object is fetched again from the pull zone it originally came
   * from and spooled to disk, so the fresh bytes can be hashed *before* the
   * stored object is touched: a copy that hashes to exactly what the manifest
   * recorded replaces what is in the bucket, while a copy that no longer matches
   * is stored *and* recorded as drift (with its new hash), because Bunny is the
   * origin and the record is what has gone stale. Nothing is re-encoded, nothing
   * is invented, and only the flagged objects move.
   *
   * When Bunny no longer holds the video there is nothing to fetch from, so the
   * repair falls back to what the bucket still has: playback moves to the tallest
   * *intact* rendition, the objects nothing can supply are dropped from the
   * record, and `manifest.json` is rewritten so the folder agrees with the bucket
   * again. Every one of those moves is recorded on the catalogue, never quietly
   * forgotten.
   *
   * The last step is a full verification of the folder as it now stands — a mend
   * nobody checked is just another claim — so the verdict on the record always
   * describes the bucket, not the intention.
   */
  private async repair(entry: CatalogEntry, task: ArchiveTask): Promise<ArchiveOutcome> {
    const r2 = this.deps.r2;
    const archive = entry.archive;
    if (!r2) return { status: 'skipped', note: 'no R2 destination is configured' };
    if (!archive) return { status: 'skipped', note: 'this title has no archive to mend' };
    const flagged = flaggedObjects(archive.verify);
    if (!flagged.length) return { status: 'skipped', note: 'the last check found nothing to mend' };

    const objects = archive.objects ?? [];
    const byName = new Map(objects.map((object) => [object.name, object]));
    const client = this.deps.client(entry);
    // Ask Bunny rather than trust the record: the video may have been deleted
    // since the archive was written, and a 404 is an answer, not a failure.
    const reachable = client && entry.videoId ? await this.bunnyHasVideo(client, entry.videoId) : false;

    this.touch(task, {
      stage: 'repairing',
      assets: flagged.length,
      stored: 0,
      bytes: 0,
      totalBytes: flagged.reduce((total, name) => total + (byName.get(name)?.bytes ?? 0), 0),
    });

    const recopied: string[] = [];
    const drifted: string[] = [];
    const unrecoverable: CatalogArchiveObject[] = [];
    const updated = new Map<string, CatalogArchiveObject>();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-repair-'));
    try {
      let bytes = 0;
      let handled = 0;
      for (const name of flagged) {
        const object = byName.get(name);
        // A name the record no longer carries (already dropped) is nothing to do.
        if (!object) continue;
        this.touch(task, { asset: name });
        const result: RepairResult = reachable && object.source ? await this.recopy(object, task, bytes, dir) : { status: 'unavailable' };
        if (result.status === 'repaired') {
          recopied.push(name);
          updated.set(name, object);
          bytes += object.bytes;
        } else if (result.status === 'drifted') {
          // The bytes Bunny serves have changed since the archive was written, so
          // the *record* is the stale half: accept them and say so.
          drifted.push(name);
          updated.set(name, { ...object, bytes: result.bytes, sha256: result.sha256 });
          bytes += result.bytes;
        } else {
          unrecoverable.push(object);
        }
        handled += 1;
        this.touch(task, { stored: handled, bytes });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    if (recopied.length + drifted.length + unrecoverable.length === 0) {
      return { status: 'skipped', note: 'nothing the last check named is still in the record' };
    }

    // Whatever is left has no source at all, so the repair falls back to the
    // bucket's own intact copies: keep the best one playable, and stop claiming
    // the objects that are gone.
    const lostNames = new Set(unrecoverable.map((object) => object.name));
    const current = playableObject(objects);
    const intact = intactPlayableObject(objects, lostNames);
    const switchedTo = current && lostNames.has(current.name) && intact ? intact.name : undefined;
    const dropped = unrecoverable.map((object) => object.name);
    const kept = objects
      .filter((object) => !lostNames.has(object.name))
      .map((object) => updated.get(object.name) ?? object);
    const at = this.nowIso();
    const nextPlayable = playableObject(kept);

    const repaired: CatalogArchive = {
      ...archive,
      objects: kept,
      bytes: kept.reduce((total, object) => total + object.bytes, 0),
      videoBytes: kept.filter((object) => object.kind === 'video').reduce((total, object) => total + object.bytes, 0),
      videos: kept.filter((object) => object.kind === 'video').length,
      // A folder that lost an object is no longer the complete set it claimed.
      complete: dropped.length > 0 ? false : archive.complete,
      repairedAt: at,
      repair: { at, recopied, dropped, drifted, ...(switchedTo ? { switchedTo } : {}) },
    };
    // The previous verdict is spent — it named objects that have just been mended
    // or dropped — and the verification at the end writes the fresh one.
    delete repaired.verify;
    // Playback follows what survived: when the rendition it named is gone, the
    // record must point at the intact neighbour rather than a hole.
    if (nextPlayable) repaired.mediaKey = nextPlayable.key;
    else delete repaired.mediaKey;

    // On the task too, so the row can say what was mended without a second read.
    this.touch(task, { repaired: [...recopied, ...drifted], dropped: [...dropped] });

    await this.writeManifest(r2, entry, repaired);
    this.writeRecord(entry.key, repaired);

    const mended = repairNote({ recopied, dropped, drifted, switchedTo });
    const verified = await this.verify({ ...entry, archive: repaired }, task);
    if (verified.status === 'skipped') return { status: 'skipped', note: `${mended}; ${verified.note ?? 'nothing left to check'}` };
    if (verified.status === 'ok') return { status: 'ok', note: `${mended}; ${verified.note ?? 'verified'}` };
    return { status: 'partial', note: `${mended}; but the folder still does not verify — ${verified.note ?? 'unknown reason'}` };
  }

  /**
   * Fetches one flagged object again from the pull zone and puts it back.
   *
   * The fresh copy is spooled to disk and hashed *before* the stored object is
   * touched, which is what keeps a changed pull zone from silently redefining the
   * archive mid-repair. Nothing is uploaded for an object the pull zone no longer
   * has.
   */
  private async recopy(object: CatalogArchiveObject, task: ArchiveTask, completedBytes: number, dir: string): Promise<RepairResult> {
    const r2 = this.deps.r2 as R2Client;
    const url = object.source;
    if (!url) return { status: 'unavailable' };

    // A HEAD that says it is gone saves downloading nothing at all.
    if ((await this.assetSize(url)) === null) return { status: 'missing' };

    const upstream = await fetchWithPolicy(
      url,
      { method: 'GET' },
      { what: 'the Bunny pull zone', fetchImpl: this.deps.fetchImpl ?? fetch, timeoutMs: ASSET_TIMEOUT_MS, retries: 2, backoffMs: 1_000 },
    );
    const body = upstream.body;
    if (!upstream.ok || !body) {
      await body?.cancel().catch(() => undefined);
      if (upstream.status === 404 || upstream.status === 403) return { status: 'missing' };
      throw new Error(`the pull zone answered HTTP ${upstream.status} for ${object.name}`);
    }

    const filePath = path.join(dir, path.basename(object.name) || 'object.bin');
    const fetched = await spoolToFile(body, filePath, (written) => this.touch(task, { bytes: completedBytes + written }));
    const upload = await r2.put(object.key, chunksOfFile(filePath), {
      contentType: object.contentType,
      ...(fetched.bytes > 0 ? { contentLength: fetched.bytes } : {}),
      onProgress: (sent) => this.touch(task, { bytes: completedBytes + sent }),
    });
    const stored = await r2.head(object.key);
    if (!stored || stored.bytes === undefined || stored.bytes !== upload.bytes) throw new Error(`${object.name} did not verify in R2 after being mended`);

    return upload.sha256 === object.sha256 ? { status: 'repaired' } : { status: 'drifted', bytes: upload.bytes, sha256: upload.sha256 };
  }

  /**
   * Rewrites `manifest.json` for an archive whose object list just changed.
   *
   * The original manifest is the base, so the history it carries — which Bunny
   * video this came from, when it was archived — is preserved; only the object
   * list and the sizes follow the mend. A manifest that is gone (the very thing a
   * check may have flagged) is rebuilt from the catalogue record instead.
   */
  private async writeManifest(r2: R2Client, entry: CatalogEntry, archive: CatalogArchive): Promise<void> {
    const previous = (await this.readManifest(r2, archive.manifestKey)) as { bunny?: unknown; archivedAt?: string } | undefined;
    const body = Buffer.from(
      `${JSON.stringify(
        {
          version: 1,
          key: entry.key,
          kind: entry.kind,
          tmdbId: entry.tmdbId,
          title: entry.title,
          ...(entry.year ? { year: entry.year } : {}),
          ...(entry.kind === 'episode' ? { season: entry.season ?? null, episode: entry.episode ?? null, episodeTitle: entry.episodeTitle ?? null } : {}),
          bunny: previous?.bunny ?? {
            accountId: entry.accountId ?? null,
            libraryId: entry.libraryId ?? null,
            videoId: entry.videoId ?? null,
            playbackUrl: entry.playbackUrl ?? null,
            resolutions: null,
          },
          archivedAt: previous?.archivedAt ?? archive.at,
          bucket: archive.bucket,
          prefix: archive.prefix,
          base: archive.base ?? null,
          bytes: archive.bytes,
          videoBytes: archive.videoBytes,
          videos: archive.videos,
          objects: archive.objects,
          repairedAt: archive.repairedAt ?? null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await r2.put(archive.manifestKey, body, { contentType: 'application/json' });
    const head = await r2.head(archive.manifestKey);
    if (!head || head.bytes !== body.length) throw new Error(`the mended manifest did not verify in R2 (${archive.manifestKey})`);
  }

  /** Whether Bunny still holds the video, asked of Bunny rather than assumed. */
  private async bunnyHasVideo(client: BunnyClient, videoId: string): Promise<boolean> {
    try {
      const video = await client.getVideo(videoId);
      // Only a finished video has renditions on the pull zone to fetch.
      return mapBunnyStatus(video.status) === 'ready';
    } catch {
      return false;
    }
  }

  /** Reads and parses a manifest out of the bucket; `undefined` when it is not there. */
  private async readManifest(r2: R2Client, key: string): Promise<{ objects?: CatalogArchiveObject[] } | undefined> {
    const text = await this.readText(r2, key);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`the manifest at ${key} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`the manifest at ${key} is not an object`);
    return parsed as { objects?: CatalogArchiveObject[] };
  }

  /** Reads a small object (a manifest, a caption) whole, as text. */
  private async readText(r2: R2Client, key: string): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    const digest = await r2.read(key, (chunk) => {
      chunks.push(chunk);
    });
    if (!digest) return undefined;
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Hands the streamed rendition to Bunny, by whichever transport is configured.
   *
   * Both take the bytes off the source as they go, so no transport here needs a
   * local copy of the film: TUS pulls chunks through the retry loop, and a PUT
   * reads the source straight into the request body.
   */
  private async upload(
    client: BunnyClient,
    videoId: string,
    title: string,
    object: CatalogArchiveObject,
    source: TusSource,
    onProgress: (bytesSent: number) => void,
  ): Promise<void> {
    const fileName = path.basename(object.name) || 'restore.mp4';
    if (this.deps.config.uploadMode === 'tus') {
      await client.uploadVideoResumable(videoId, undefined, {
        title,
        fileName,
        source,
        chunkBytes: this.deps.config.tusChunkBytes,
        onProgress,
        shouldContinue: () => !this.stopped,
      });
      return;
    }
    await client.uploadVideoStream(videoId, source);
    onProgress(source.totalBytes);
  }

  /** Re-attaches every caption the folder holds, keyed by the language in its name. */
  private async reapplyCaptions(client: BunnyClient, videoId: string, entry: CatalogEntry, archive: CatalogArchive, r2: R2Client): Promise<string[]> {
    const captions = (archive.objects ?? []).filter((object) => object.kind === 'subtitle');
    const failed: string[] = [];
    for (const object of captions) {
      const srclang = captionLanguage(object.name);
      try {
        const text = await this.readText(r2, object.key);
        if (text === undefined) throw new Error('the caption is not in the bucket');
        const label = entry.subtitles?.find((track) => track.srclang === srclang)?.label ?? srclang.toUpperCase();
        await client.addCaption(videoId, srclang, label, text);
      } catch (error) {
        failed.push(srclang);
        this.logLine(`[archive] ${entry.key}: could not re-attach the ${srclang} caption — ${describeError(error)}`);
      }
    }
    return failed;
  }

  /** Writes a verification result onto the catalogue entry, and never fails the pass for it. */
  private recordVerify(key: string, verify: NonNullable<CatalogArchive['verify']>): void {
    try {
      this.deps.catalog.setArchiveVerify(key, verify);
    } catch (error) {
      this.logLine(`[archive] could not record the verification of ${key}: ${describeError(error)}`);
    }
  }

  /** Writes a restored video onto the catalogue entry, and never fails the run for it. */
  private writeRestore(key: string, restore: { videoId: string; playbackUrl?: string; bunnyStatus?: number; at: string }): void {
    try {
      this.deps.catalog.setRestored(key, restore);
    } catch (error) {
      this.logLine(`[archive] could not record the restore of ${key}: ${describeError(error)}`);
    }
  }

  /**
   * Measures the whole job before any of it moves.
   *
   * Every file the plan names is HEAD-ed, and the files Bunny did not generate
   * simply drop out — a `thumbnail_3.jpg` that does not exist is not a failure,
   * it is a smaller job. The seek sprites are discovered here too: they are
   * numbered from `_0.jpg` with no count published anywhere, so they are probed
   * until the first one that is not there.
   */
  private async scan(base: string, entry: CatalogEntry, video: BunnyVideo, task: ArchiveTask): Promise<ProbedAsset[]> {
    const assets: ProbedAsset[] = [];
    const measure = async (planned: PlannedAsset): Promise<boolean> => {
      const size = await this.assetSize(planned.url);
      if (size === null) return false;
      assets.push({ ...planned, ...(size !== undefined ? { bytes: size } : {}) });
      this.touch(task, { assets: assets.length, totalBytes: planBytes(assets) });
      return true;
    };

    for (const planned of planAssets(video, base, captionLanguages(entry, video))) await measure(planned);

    const videoId = video.guid;
    for (let index = 0; index < MAX_SEEK_SPRITES; index += 1) {
      const planned: PlannedAsset = {
        name: `sprites/seek_${index}.jpg`,
        kind: 'sprite',
        url: seekSpriteUrl(base, videoId, index),
        contentType: 'image/jpeg',
      };
      if (!(await measure(planned))) break;
    }
    return assets;
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
   * One asset: stream it into R2 once, confirm it landed, and report the bytes
   * as they go.
   *
   * The size came from the scan, so R2 is told the length up front (which is
   * what lets a big file become a real multipart upload instead of a buffered
   * PUT). The HEAD against R2 afterwards is the verification: the archive only
   * counts objects the bucket itself says are there, at the size that was
   * uploaded.
   */
  private async move(asset: ProbedAsset, key: string, task: ArchiveTask, completedBytes: number): Promise<CatalogArchiveObject> {
    const r2 = this.deps.r2 as R2Client;
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
        ...(asset.bytes !== undefined ? { contentLength: asset.bytes } : {}),
        onProgress: (uploaded) => this.touch(task, { bytes: completedBytes + uploaded }),
      });
    } catch (error) {
      // Give the download back rather than leaving it half-read on a socket.
      await body.cancel().catch(() => undefined);
      throw error;
    }
    if (asset.bytes !== undefined && upload.bytes !== asset.bytes) {
      throw new Error(`${asset.name} uploaded ${upload.bytes} bytes but the pull zone declared ${asset.bytes}`);
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

/** One sentence describing what a repair did, for a task note and a log line. */
function repairNote(repair: { recopied: string[]; dropped: string[]; drifted: string[]; switchedTo?: string }): string {
  const parts: string[] = [];
  if (repair.recopied.length) parts.push(`re-copied ${repair.recopied.length} object(s) from Bunny`);
  if (repair.drifted.length) parts.push(`Bunny's copy of ${repair.drifted.length} object(s) had changed, so their recorded hashes were updated`);
  if (repair.dropped.length) parts.push(`${repair.dropped.length} object(s) could not be mended (${repair.dropped.slice(0, 3).join(', ')}) and were dropped`);
  if (repair.switchedTo) parts.push(`playback moved to the intact ${repair.switchedTo}`);
  return parts.length ? parts.join('; ') : 'nothing needed mending';
}

/**
 * Streams a response body to disk, hashing and counting as it lands.
 *
 * The hash is what decides whether the fresh bytes are the object the manifest
 * recorded, so it has to be taken *before* anything is overwritten — which is
 * why a repair spools to disk instead of streaming straight into the bucket.
 */
async function spoolToFile(body: ReadableStream<Uint8Array>, filePath: string, onProgress: (written: number) => void): Promise<{ bytes: number; sha256: string }> {
  const handle = await fs.promises.open(filePath, 'w');
  const hash = crypto.createHash('sha256');
  const reader = body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await handle.write(chunk, 0, chunk.length, written);
      written += chunk.length;
      onProgress(written);
    }
  } finally {
    reader.releaseLock?.();
    await handle.close();
  }
  return { bytes: written, sha256: hash.digest('hex') };
}

/**
 * One archived object, as the byte source a restore streams from.
 *
 * TUS asks two things of a source that a bucket `GET` does not answer on its own:
 * the total length before it starts (TUS demands a declared `Upload-Length`), and
 * a re-read of the range it just sent when Bunny stored only part of a chunk —
 * while an R2 body is a forward-only stream that cannot be rewound. This bridges
 * the two by pulling the body in order and keeping only the range it last handed
 * out, which is exactly the range a retry asks for again. A resumed upload starts
 * part-way in, so anything before its offset is pulled and dropped rather than
 * reopened.
 *
 * Every byte pulled goes through a running SHA-256, so the object is verified
 * against the manifest in the same pass that puts it back in Bunny. The digest is
 * only final once the last byte has been read, which is why [finish] exists: a
 * transport that answers without reading the body still leaves a verdict.
 */
export class StreamedObject implements TusSource {
  readonly totalBytes: number;
  /** Bytes handed to the caller, as a high-water mark. */
  private delivered = 0;
  /** Pulled from the bucket through the hash, but not yet handed out. */
  private buffered: Buffer = Buffer.alloc(0);
  /** What the previous read returned, kept because a TUS retry asks for it again. */
  private last?: { offset: number; bytes: Buffer };
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private ended = false;
  private finished?: { bytes: number; sha256: string };
  private pulled = 0;
  private readonly hash = crypto.createHash('sha256');

  constructor(
    private readonly body: ReadableStream<Uint8Array>,
    totalBytes: number,
    /** Called with the running byte count as the object is pulled. */
    private readonly onRead: (bytes: number) => void = () => undefined,
  ) {
    this.totalBytes = totalBytes;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    if (offset >= this.delivered) return this.remember(offset, await this.forward(offset, length));

    // A retry asks again for the range it just sent, or the tail of it when Bunny
    // stored part of the chunk: serve that from the copy still in hand, because a
    // bucket GET cannot be rewound.
    const last = this.last;
    if (!last || offset < last.offset) {
      throw new Error(`the archived object can only be streamed forwards (asked for byte ${offset} after reading ${this.delivered})`);
    }
    const from = offset - last.offset;
    const head = last.bytes.subarray(from, from + length);
    if (head.length >= length) return this.remember(offset, head);
    const rest = await this.forward(last.offset + last.bytes.length, length - head.length);
    return this.remember(offset, Buffer.concat([head, rest]));
  }

  /** Pulls the bucket body until `length` bytes from `offset` are in hand. */
  private async forward(offset: number, length: number): Promise<Buffer> {
    // A resumed upload starts part-way in. The bytes it skips are still pulled
    // through the hash — every byte that comes out of the bucket is — and then
    // dropped, because a GET cannot be told to open anywhere but the start.
    const oldest = this.pulled - this.buffered.length;
    if (offset < oldest) {
      throw new Error(`the archived object can only be streamed forwards (asked for byte ${offset} after dropping ${oldest})`);
    }
    let discard = offset - oldest;

    const parts: Buffer[] = [];
    let wanted = length;
    while (wanted > 0) {
      if (this.buffered.length === 0) {
        if (this.ended) break;
        if (!this.reader) this.reader = this.body.getReader();
        const { done, value } = await this.reader.read();
        if (done) {
          this.ended = true;
          break;
        }
        if (!value?.length) continue;
        const chunk = Buffer.from(value);
        this.hash.update(chunk);
        this.pulled += chunk.length;
        this.onRead(this.pulled);
        this.buffered = chunk;
      }
      if (discard > 0) {
        const dropped = Math.min(discard, this.buffered.length);
        this.buffered = this.buffered.subarray(dropped);
        discard -= dropped;
        continue;
      }
      const slice = this.buffered.subarray(0, Math.min(wanted, this.buffered.length));
      parts.push(slice);
      this.buffered = this.buffered.subarray(slice.length);
      wanted -= slice.length;
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }

  private remember(offset: number, bytes: Buffer): Buffer {
    this.last = { offset, bytes };
    this.delivered = Math.max(this.delivered, offset + bytes.length);
    return bytes;
  }

  /**
   * The SHA-256 of everything read, completing the read first when a transport
   * answered without pulling the body (a mock Bunny, or a PUT nobody wrote) — the
   * verdict has to be about the archive rather than about the transport.
   */
  async finish(): Promise<{ bytes: number; sha256: string }> {
    while (!this.ended && this.delivered < this.totalBytes) {
      const chunk = await this.read(this.delivered, this.totalBytes - this.delivered);
      if (chunk.length === 0) break;
    }
    this.finished ??= { bytes: this.pulled, sha256: this.hash.digest('hex') };
    return this.finished;
  }

  /** Releases the bucket connection as soon as nothing more is needed from it. */
  async close(): Promise<void> {
    const reader = this.reader;
    this.reader = undefined;
    this.ended = true;
    this.buffered = Buffer.alloc(0);
    await reader?.cancel().catch(() => undefined);
  }
}

/**
 * Opens an archived object as a byte source, asking the bucket *before* anything
 * is created in Bunny: a rendition that is not there must fail the restore rather
 * than leave an empty video behind. A `403` still throws — a refusal is not an
 * absent object.
 */
export async function streamedObject(r2: R2Client, object: CatalogArchiveObject, onRead?: (bytes: number) => void): Promise<StreamedObject> {
  const body = await r2.open(object.key);
  if (!body) throw new Error(`${object.name} is not in the bucket (${object.key})`);
  return new StreamedObject(body, object.bytes, onRead);
}

/** One flagged object, and what fetching it again produced. */
type RepairResult = { status: 'repaired' } | { status: 'drifted'; bytes: number; sha256: string } | { status: 'missing' } | { status: 'unavailable' };

/** A file on disk, as the chunk stream the R2 client uploads from. */
async function* chunksOfFile(filePath: string): AsyncIterable<Buffer> {
  for await (const chunk of fs.createReadStream(filePath)) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
