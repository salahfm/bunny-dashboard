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

  constructor(config: AppConfig) {
    this.filePath = path.join(config.dataDir, 'catalog.json');
    this.db = this.load();
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
    this.save();
    return entry;
  }

  remove(key: string): boolean {
    const index = this.db.entries.findIndex((entry) => entry.key === key);
    if (index === -1) return false;
    this.db.entries.splice(index, 1);
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
    let first: string | null = null;
    let last: string | null = null;
    for (const entry of entries) {
      publishes += entry.publishes;
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
      firstPublishedAt: first,
      lastPublishedAt: last,
    };
  }
}
