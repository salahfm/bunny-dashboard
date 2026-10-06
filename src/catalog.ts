/**
 * The published catalogue: one permanent record per title that finished
 * publishing, holding everything the dashboard knows about it.
 *
 * Jobs are transient — a finished job is deleted from the queue and the queue
 * stays small — but the answer to "what did we publish, at which quality, from
 * which source, and where does it play?" must not be. So the moment a job turns
 * ready its full record is written here, including the *whole* ladder of
 * qualities the chosen source offered and every candidate URL (with the
 * headers each one needed), not just the tier that happened to be downloaded.
 *
 * Stored separately from `db.json` on purpose: the queue rewrites that file on
 * every structural change, and a catalogue that only grows would make each of
 * those writes bigger forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import type { Account, Job, JobSource, JobTarget, SubtitleTrack } from './store';
import { targetKey } from './store';

/** One rung of the quality ladder the published source declared. */
export interface CatalogTier {
  label: string;
  height: number;
  url: string;
  bandwidth?: number;
}

/** One object an archive stored in R2. */
export interface CatalogArchiveObject {
  /** Where it sits inside the title's folder, e.g. `video/1080p.mp4`. */
  name: string;
  /** The full object key in the bucket. */
  key: string;
  /** `video`, `original`, `thumbnail`, `preview`, `sprite`, `subtitle`, `playlist` or `manifest`. */
  kind: string;
  bytes: number;
  sha256: string;
  contentType: string;
  /** The pull-zone URL it was downloaded from, before Bunny let the video go. */
  source?: string;
}

/**
 * What happened to a title in the R2 archive.
 *
 * The point of the record is that it answers, months later, "where is this
 * video, and can it be checked?": every object's key, size and SHA-256, and
 * whether Bunny was actually told to forget the video or is still holding a
 * copy because something did not verify.
 */
export interface CatalogArchive {
  bucket: string;
  /** The title's folder in the bucket, e.g. `archive/Movies/Inception (2010) [27205]`. */
  prefix: string;
  /** The folder's public URL, when the bucket is served through a domain. */
  base?: string;
  objects: CatalogArchiveObject[];
  manifestKey: string;
  /** The folder's total size, and the share of it that is video renditions. */
  bytes: number;
  videoBytes: number;
  /** How many MP4 renditions were stored. */
  videos: number;
  /** Every asset was stored and verified, and the manifest was written. */
  complete: boolean;
  /** Why it stopped short, when it did. */
  note?: string;
  /** The Bunny video it was copied from. */
  videoId: string;
  /**
   * Where it plays now: the public URL when the bucket is served through a
   * domain, otherwise the dashboard's own play route, which mints a short-lived
   * signed R2 URL for every request.
   */
  playbackUrl?: string;
  /**
   * The archived object the dashboard streams for playback — the tallest MP4
   * rendition, or the original file when that is all there is.
   */
  mediaKey?: string;
  /** Bunny's own playback URL, which the archive replaces. */
  bunnyPlaybackUrl?: string;
  removedFromBunny: boolean;
  removedAt?: string;
  /** The last time every object was re-read from the bucket and hashed. */
  verifiedAt?: string;
  /** What that pass found: how many objects were checked, and which failed. */
  verify?: {
    at: string;
    ok: boolean;
    checked: number;
    /** Objects the manifest lists that are no longer in the bucket. */
    missing: string[];
    /** Objects whose bytes no longer hash to what the manifest recorded. */
    mismatched: string[];
  };
  /** The Bunny video a restore created, and when it did. */
  restoredAt?: string;
  restoredVideoId?: string;
  /** The last time the objects a check flagged were repaired, and what happened. */
  repairedAt?: string;
  repair?: {
    at: string;
    /** Objects re-copied from Bunny that hashed to the manifest and verified again. */
    recopied: string[];
    /** Objects nothing could supply; dropped from the record and the manifest. */
    dropped: string[];
    /** Bunny's copy of these no longer matches what was archived (left as found). */
    drifted: string[];
    /** The rendition playback was moved onto, when the flagged one was lost. */
    switchedTo?: string;
  };
  at: string;
}

/** One source the scrape found, kept with the URL and headers it needed. */
export interface CatalogSource {
  provider: string;
  quality: string;
  height: number;
  url: string;
  type?: 'hls' | 'mp4';
  directFile?: boolean;
  headers?: Record<string, string>;
  chosen?: boolean;
  note?: string;
}

export interface CatalogEntry {
  /** `movie:<tmdbId>` or `episode:<tmdbId>:<season>:<episode>`. */
  key: string;
  kind: 'movie' | 'episode';
  tmdbId: number;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  posterPath?: string | null;

  /* ---- where it plays ---- */
  videoId?: string;
  playbackUrl?: string;
  accountId?: string;
  accountName?: string;
  libraryId?: string;
  pullZoneHost?: string;
  transport?: 'tunnel' | 'direct';
  bunnyStatus?: number;

  /* ---- what was published ---- */
  /** The tier that was downloaded and handed to Bunny. */
  quality?: string;
  /** The host that handed out the chosen source. */
  provider?: string;
  /** The media URL that was actually downloaded. */
  sourceUrl?: string;
  /** The headers that URL required. */
  sourceHeaders?: Record<string, string>;
  /** Every quality the chosen source offered, best first. */
  tiers: CatalogTier[];
  /** Every source the scrape probed, with its URL, headers and verdict. */
  sources: CatalogSource[];
  /**
   * The subtitle tracks this title was published with.
   *
   * One per caption Bunny now holds — scraped from the stream, or translated
   * into the target language from one that was. Kept here so "does this title
   * have Arabic?" is answerable from the catalogue alone.
   */
  subtitles: SubtitleTrack[];

  /*
   * Where the title lives once Bunny is done with it.
   *
   * Absent for a title nobody archived; present with `complete: false` when an
   * archive started and did not finish, which is also the flag for "Bunny may
   * still hold this video".
   */
  archive?: CatalogArchive;

  /* ---- where the job came from ---- */
  origin: {
    kind: JobSource['kind'];
    mode?: 'scrape' | 'source';
    name: string;
    input?: string;
    minHeight?: number;
    only?: string[];
  };

  /* ---- sizes ---- */
  bytes: {
    /** Size the source declared. */
    declared?: number;
    /** Bytes downloaded from the source. */
    downloaded?: number;
    /** Bytes handed to Bunny. */
    handedOver?: number;
    /** Bytes of an uploaded local file. */
    file?: number;
  };

  jobId: string;
  /** How many times this title has finished publishing. */
  publishes: number;
  firstPublishedAt: string;
  updatedAt: string;
}

export interface CatalogStats {
  total: number;
  movies: number;
  episodes: number;
  publishes: number;
  /** Published size, in bytes, summed over entries that declared one. */
  bytes: number;
  /** How many entries were published at each tier label. */
  byQuality: Record<string, number>;
  /** Titles copied into R2, and the total size of those folders. */
  archived: number;
  archivedBytes: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
}

export interface CatalogDb {
  version: 1;
  entries: CatalogEntry[];
}

function originOf(source: JobSource): CatalogEntry['origin'] {
  return {
    kind: source.kind,
    name: source.name,
    ...(source.mode !== undefined ? { mode: source.mode } : {}),
    ...(source.input !== undefined ? { input: source.input } : {}),
    ...(source.minHeight !== undefined ? { minHeight: source.minHeight } : {}),
    ...(source.only && source.only.length ? { only: source.only } : {}),
  };
}

function sizesOf(job: Job): CatalogEntry['bytes'] {
  return {
    ...(job.totalBytes !== undefined ? { declared: job.totalBytes } : {}),
    ...(job.bytesIn !== undefined ? { downloaded: job.bytesIn } : {}),
    ...(job.bytesOut !== undefined ? { handedOver: job.bytesOut } : {}),
    ...(job.source.bytes !== undefined ? { file: job.source.bytes } : {}),
  };
}

/** Everything a job knows, flattened into one catalogue record. */
export function entryFromJob(job: Job, account: Account | undefined, existing: CatalogEntry | undefined, now: string): CatalogEntry {
  const target: JobTarget = job.target;
  const source = job.source;
  return {
    key: targetKey(target),
    kind: target.kind,
    tmdbId: target.tmdbId,
    title: target.title,
    ...(target.year !== undefined ? { year: target.year } : {}),
    ...(target.kind === 'episode' && target.season !== undefined ? { season: target.season } : {}),
    ...(target.kind === 'episode' && target.episode !== undefined ? { episode: target.episode } : {}),
    ...(target.episodeTitle !== undefined ? { episodeTitle: target.episodeTitle } : {}),
    ...(target.posterPath !== undefined ? { posterPath: target.posterPath } : {}),

    ...(job.bunnyVideoId !== undefined ? { videoId: job.bunnyVideoId } : {}),
    ...(job.playbackUrl !== undefined ? { playbackUrl: job.playbackUrl } : {}),
    ...(job.accountId !== undefined ? { accountId: job.accountId } : {}),
    ...(account?.name !== undefined ? { accountName: account.name } : {}),
    ...(account?.libraryId !== undefined ? { libraryId: account.libraryId } : {}),
    ...(account?.pullZoneHost !== undefined ? { pullZoneHost: account.pullZoneHost } : {}),
    ...(job.transport !== undefined ? { transport: job.transport } : {}),
    ...(job.statusCode !== undefined ? { bunnyStatus: job.statusCode } : {}),

    ...(source.quality !== undefined ? { quality: source.quality } : {}),
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    ...(source.url !== undefined ? { sourceUrl: source.url } : {}),
    ...(source.headers !== undefined ? { sourceHeaders: source.headers } : {}),
    tiers: Array.isArray(source.tiers) ? source.tiers.map((tier) => ({ ...tier })) : [],
    sources: Array.isArray(job.candidates) ? job.candidates.map((candidate) => ({ ...candidate })) : [],
    subtitles: Array.isArray(job.subtitles) ? job.subtitles.map((track) => ({ ...track })) : [],

    origin: originOf(source),
    bytes: sizesOf(job),

    jobId: job.id,
    publishes: (existing?.publishes ?? 0) + 1,
    firstPublishedAt: existing?.firstPublishedAt ?? now,
    updatedAt: now,
  };
}

export class Catalog {
  private db: CatalogDb;
  private filePath: string;
  /** Bumped by every change, so a watcher can tell "nothing moved" cheaply. */
  private changes = 0;

  constructor(config: AppConfig) {
    this.filePath = path.join(config.dataDir, 'catalog.json');
    this.db = this.load();
  }

  /**
   * A counter that changes with every record added, rewritten or removed.
   *
   * `size` only moves when a *new* title is published, but the interesting
   * events also include a caption attached to a title that already exists — so
   * the live event stream watches this instead, and the Library redraws when a
   * backfill lands without the operator reloading.
   */
  get revision(): number {
    return this.changes;
  }

  private load(): CatalogDb {
    if (!fs.existsSync(this.filePath)) return { version: 1, entries: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<CatalogDb>;
      return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
    } catch {
      // A catalogue that cannot be parsed must not stop the dashboard; keep the
      // bad file around and start clean, exactly like the queue store does.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* the rename is best effort */
      }
      return { version: 1, entries: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.db, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }

  get size(): number {
    return this.db.entries.length;
  }

  get path(): string {
    return this.filePath;
  }

  /** Every entry, newest publication first. */
  all(): CatalogEntry[] {
    return [...this.db.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(key: string): CatalogEntry | undefined {
    return this.db.entries.find((entry) => entry.key === key);
  }

  /**
   * Records a finished job. Publishing the same title again updates the one
   * entry (new video, new source, new ladder) and counts the publish — the
   * record is a stable identity, not a log of every attempt.
   */
  record(job: Job, account?: Account): CatalogEntry {
    const key = targetKey(job.target);
    const index = this.db.entries.findIndex((entry) => entry.key === key);
    const existing = index >= 0 ? this.db.entries[index] : undefined;
    const entry = entryFromJob(job, account, existing, new Date().toISOString());
    if (index >= 0) this.db.entries[index] = entry;
    else this.db.entries.push(entry);
    this.changes += 1;
    this.save();
    return entry;
  }

  /**
   * Rewrites one entry's subtitle list.
   *
   * The video itself did not change — the backfill attached a caption to it — so
   * nothing else about the record is touched, only the tracks and the timestamp.
   */
  setSubtitles(key: string, subtitles: SubtitleTrack[]): CatalogEntry | undefined {
    const entry = this.get(key);
    if (!entry) return undefined;
    entry.subtitles = subtitles.map((track) => ({ ...track }));
    entry.updatedAt = new Date().toISOString();
    this.changes += 1;
    this.save();
    return entry;
  }

  /**
   * Attaches an archive record to an entry.
   *
   * The video itself did not change — it was copied somewhere else and, usually,
   * deleted from Bunny — so nothing but the archive block, the playback URL and
   * the timestamp move. `playbackUrl` follows the archive only when the bucket
   * has a public base: otherwise the old Bunny URL is the only link that ever
   * worked, and it is kept (with the archive's own note) rather than blanked.
   */
  setArchive(key: string, archive: CatalogArchive): CatalogEntry | undefined {
    const entry = this.get(key);
    if (!entry) return undefined;
    entry.archive = archive;
    // The Bunny URL is only replaced once the archive is whole: pointing at a
    // public R2 folder that is still half-uploaded would break playback for a
    // title whose Bunny copy works.
    if (archive.complete && archive.playbackUrl) entry.playbackUrl = archive.playbackUrl;
    entry.updatedAt = new Date().toISOString();
    this.changes += 1;
    this.save();
    return entry;
  }

  /**
   * Records the outcome of a verification pass on an archived title.
   *
   * Only the verify block and the timestamp move: the copy itself did not
   * change, it was re-read, so nothing about where the title plays is touched.
   */
  setArchiveVerify(key: string, verify: NonNullable<CatalogArchive['verify']>): CatalogEntry | undefined {
    const entry = this.get(key);
    if (!entry?.archive) return undefined;
    entry.archive.verify = verify;
    entry.archive.verifiedAt = verify.at;
    entry.updatedAt = new Date().toISOString();
    this.changes += 1;
    this.save();
    return entry;
  }

  /**
   * Points an entry at the Bunny video a restore just created.
   *
   * The copy in R2 is untouched — a restore puts a *second* copy back in Bunny
   * rather than moving the archive — so the archive block only gains the note
   * that the title is live in Bunny again, and the top-level playback fields
   * follow the new video.
   */
  setRestored(key: string, restore: { videoId: string; playbackUrl?: string; bunnyStatus?: number; at: string }): CatalogEntry | undefined {
    const entry = this.get(key);
    if (!entry) return undefined;
    entry.videoId = restore.videoId;
    if (restore.playbackUrl !== undefined) entry.playbackUrl = restore.playbackUrl;
    if (restore.bunnyStatus !== undefined) entry.bunnyStatus = restore.bunnyStatus;
    if (entry.archive) {
      entry.archive.restoredAt = restore.at;
      entry.archive.restoredVideoId = restore.videoId;
    }
    entry.updatedAt = new Date().toISOString();
    this.changes += 1;
    this.save();
    return entry;
  }

  remove(key: string): boolean {
    const index = this.db.entries.findIndex((entry) => entry.key === key);
    if (index === -1) return false;
    this.db.entries.splice(index, 1);
    this.changes += 1;
    this.save();
    return true;
  }

  /** Free-text match over the fields an operator would search by. */
  search(query: string): CatalogEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.all();
    return this.all().filter((entry) =>
      [
        entry.title,
        entry.year,
        entry.key,
        String(entry.tmdbId),
        entry.quality,
        entry.provider,
        entry.accountName,
        entry.pullZoneHost,
        entry.videoId,
        entry.episodeTitle,
        ...entry.tiers.map((tier) => tier.label),
        ...entry.sources.map((source) => source.provider),
        // A subtitle language is a real search: "which titles have Arabic?".
        ...(entry.subtitles ?? []).flatMap((track) => [track.srclang, track.label]),
        entry.archive?.bucket,
        entry.archive?.prefix,
        // "r2" and "arched"/"local" are how the Library is asked which titles
        // have been moved and which are still only on Bunny.
        entry.archive ? 'r2 archived' : 'bunny',
      ]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }

  stats(): CatalogStats {
    const entries = this.db.entries;
    let bytes = 0;
    let publishes = 0;
    const byQuality: Record<string, number> = {};
    let archived = 0;
    let archivedBytes = 0;
    let first: string | null = null;
    let last: string | null = null;
    for (const entry of entries) {
      publishes += entry.publishes;
      if (entry.archive) {
        archived += 1;
        archivedBytes += entry.archive.bytes;
      }
      const size = entry.bytes.declared ?? entry.bytes.file ?? entry.bytes.downloaded ?? 0;
      if (Number.isFinite(size)) bytes += size;
      const quality = entry.quality ?? (entry.tiers[0]?.label ?? 'unknown');
      byQuality[quality] = (byQuality[quality] ?? 0) + 1;
      if (!first || entry.firstPublishedAt < first) first = entry.firstPublishedAt;
      if (!last || entry.updatedAt > last) last = entry.updatedAt;
    }
    return {
      total: entries.length,
      movies: entries.filter((entry) => entry.kind === 'movie').length,
      episodes: entries.filter((entry) => entry.kind === 'episode').length,
      publishes,
      bytes,
      byQuality,
      archived,
      archivedBytes,
      firstPublishedAt: first,
      lastPublishedAt: last,
    };
  }
}
