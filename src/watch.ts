/**
 * Watched-folder mode: new video files dropped into a folder are matched to
 * TMDB by their release name and queued automatically.
 *
 * Filenames are parsed the way scene releases are named (`Title.2010.1080p`,
 * `Show.S01E02.2160p`, `Show - 1x02`) — the title, year and episode numbers are
 * extracted, everything else (codecs, sources, group tags) is discarded. The
 * parsed title is searched on TMDB and the best candidate is confirmed with the
 * real movie/show detail before a job is created.
 *
 * A matched file is moved into the uploads directory, so the watched folder
 * stays an inbox: whatever is still sitting there is something the watcher could
 * not resolve.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import type { Store } from './store';
import type { JobTarget } from './store';
import type { TmdbClient, TmdbSearchResult } from './tmdb';

/** Release tags that end the title: `Inception 2010 1080p BluRay x264-GROUP`. */
const NOISE_PATTERNS: RegExp[] = [
  /^(?:19|20)\d{2}$/, // a bare year (already extracted, but stops the title here)
  /^\d{3,4}p$/,
  /^\d{3,4}x\d{3,4}$/,
  /^[48]k$/,
  /^(?:uhd|fhd|hd|sd)$/,
  /^hdr\d*(?:plus)?$/,
  /^(?:sdr|dv|10bit|8bit|10bits?)$/,
  /^(?:x26[45]|h26[45]|hevc|avc|xvid|divx)$/,
  /^(?:aac|ac3|eac3|dd[p+]?\d*|dts(?:hd)?|truehd|atmos|flac|opus|mp3)\d*$/,
  /^(?:bluray|blu-ray|bdrip|brrip|bdremux|remux|webrip|webdl|web-dl|web|hdtv|pdtv|dvdrip|dvd|hdrip|hdcam|cam|dvdscr|screener)$/,
  /^(?:proper|repack|extended|uncut|unrated|remastered|imax|complete|internal|limited)$/,
  /^(?:multi\d*|dual|subs?|subbed|dubbed|vostfr)$/,
  /^[a-z0-9]+-(?:group|rarbg|yts|yify|amiable|ntb|cmrg|evo|fgt|sparks|framestor|successfulcrab)$/,
];

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'flv', 'wmv', 'm2v', 'vob']);

export interface ParsedRelease {
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  /** Set when the name clearly describes an episode but the numbers are missing. */
  seasonOnly?: boolean;
}

export function isVideoFile(fileName: string): boolean {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return VIDEO_EXTENSIONS.has(extension);
}

function isNoiseToken(token: string): boolean {
  const value = token.toLowerCase();
  if (!value) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

/** `Show.Name.S01E02.1080p.WEB-DL.x264-GROUP.mkv` → title, season, episode. */
export function parseReleaseName(fileName: string): ParsedRelease {
  const base = fileName.replace(/\.[A-Za-z0-9]{2,4}$/, '');
  let text = ` ${base.replace(/[._]+/g, ' ').replace(/[\[\](){}]+/g, ' ')} `.replace(/\s+/g, ' ');

  let season: number | undefined;
  let episode: number | undefined;
  const patterns = [
    /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{2,3})\b/i,
    /\bseason\s*(\d{1,2})\s*episode\s*(\d{1,3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    season = Number(match[1]);
    episode = Number(match[2]);
    // Everything after the episode marker is episode title / release tags.
    text = text.slice(0, match.index);
    break;
  }
  let seasonOnly = false;
  if (season === undefined) {
    const seasonMatch = text.match(/\bs(\d{1,2})\b/i);
    if (seasonMatch?.index !== undefined) {
      seasonOnly = true;
      text = text.slice(0, seasonMatch.index);
    }
  }

  let year: string | undefined;
  const yearMatch = text.match(/(?:^|\s)((?:19|20)\d{2})(?=\s|$)/);
  if (yearMatch?.[1]) {
    year = yearMatch[1];
    text = yearMatch.index === undefined ? text.replace(yearMatch[1], ' ') : `${text.slice(0, yearMatch.index)} ${text.slice(yearMatch.index + yearMatch[0].length)}`;
  }

  const words: string[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (isNoiseToken(token)) break;
    words.push(token);
  }
  const title = words.join(' ').replace(/[-–]+$/g, '').replace(/\s+/g, ' ').trim();

  const parsed: ParsedRelease = { title };
  if (year) parsed.year = year;
  if (season !== undefined && episode !== undefined) {
    parsed.season = season;
    parsed.episode = episode;
  }
  if (seasonOnly) parsed.seasonOnly = true;
  return parsed;
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Confidence threshold. Only an exact title is trusted on its own: a prefix or
 * partial title needs a year that agrees, so “Batman Forever Special Edition”
 * without a year is reported rather than guessed.
 */
export const MIN_MATCH_SCORE = 65;

export function scoreCandidate(result: TmdbSearchResult, parsed: ParsedRelease): number | undefined {
  if (parsed.season !== undefined && result.mediaType !== 'tv') return undefined;
  const wanted = normalizeTitle(parsed.title);
  const actual = normalizeTitle(result.title);
  if (!wanted || !actual) return undefined;

  let score: number;
  if (wanted === actual) score = 100;
  else if (actual.startsWith(wanted) || wanted.startsWith(actual)) score = 50;
  else if (actual.includes(wanted) || wanted.includes(actual)) score = 30;
  else return undefined;

  if (parsed.year) {
    if (result.year === parsed.year) score += 40;
    else if (result.year && Math.abs(Number(result.year) - Number(parsed.year)) <= 1) score += 10;
    else if (result.year) score -= 25;
  }
  if (parsed.season !== undefined && result.mediaType === 'tv') score += 15;
  if (parsed.season === undefined && result.mediaType === 'movie') score += 10;
  return score;
}

export function bestMatch(results: TmdbSearchResult[], parsed: ParsedRelease): TmdbSearchResult | undefined {
  let best: TmdbSearchResult | undefined;
  let bestScore = MIN_MATCH_SCORE;
  for (const result of results) {
    const score = scoreCandidate(result, parsed);
    if (score === undefined) continue;
    const total = score + (result.voteAverage ?? 0) / 10;
    if (total > bestScore) {
      best = result;
      bestScore = total;
    }
  }
  return best;
}

/** How long an unresolved file waits before the watcher tries TMDB again. */
export const RETRY_UNMATCHED_MS = 5 * 60_000;

export type WatchFileStatus = 'waiting' | 'queued' | 'unmatched' | 'error';

export interface WatchFileView {
  name: string;
  size: number;
  modifiedAt: string;
  status: WatchFileStatus;
  title?: string;
  target?: JobTarget;
  jobId?: string;
  error?: string;
  attempts: number;
  at: string;
}

export interface WatchState {
  enabled: boolean;
  dir: string | null;
  scanning: boolean;
  folderError: string | null;
  intervalMs: number;
  minAgeMs: number;
  lastScanAt: string | null;
  counts: Record<WatchFileStatus, number>;
  files: WatchFileView[];
}

export class WatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchError';
  }
}

export interface WatcherDeps {
  config: AppConfig;
  store: Store;
  tmdb: () => TmdbClient;
  enqueue: (target: JobTarget, tempPath: string, name: string, bytes: number) => { id: string };
  now?: () => number;
}

const MAX_DEPTH = 2;
const MAX_ENTRIES = 100;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy a watched file into the uploads directory and delete the source only
 * after the copy is verifiably complete — the watched folder is the user's
 * only copy of the file until this succeeds.
 */
export function copyIntoUploads(sourcePath: string, uploadsDir: string): string {
  const target = path.join(uploadsDir, `${crypto.randomUUID()}.bin`);
  fs.copyFileSync(sourcePath, target);
  const sourceSize = fs.statSync(sourcePath).size;
  const targetSize = fs.statSync(target).size;
  if (sourceSize !== targetSize) {
    fs.rmSync(target, { force: true });
    throw new WatchError(`the copy into the uploads folder was truncated (${targetSize} of ${sourceSize} bytes)`);
  }
  fs.rmSync(sourcePath, { force: true });
  return target;
}

/** Move a watched file into the uploads directory (rename, or a copy across drives). */
export function moveIntoUploads(sourcePath: string, uploadsDir: string): string {
  const target = path.join(uploadsDir, `${crypto.randomUUID()}.bin`);
  try {
    fs.renameSync(sourcePath, target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  return copyIntoUploads(sourcePath, uploadsDir);
}

function collectFiles(root: string, depth = 0): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) files.push(...collectFiles(full, depth + 1));
      continue;
    }
    if (entry.isFile()) files.push(full);
  }
  return files;
}

export class FolderWatcher {
  private config: AppConfig;
  private store: Store;
  private tmdb: () => TmdbClient;
  private enqueue: WatcherDeps['enqueue'];
  private now: () => number;
  private entries = new Map<string, WatchFileView>();
  private active = new Set<string>();
  /** `name → size:mtime` of the instance that was last queued or attempted. */
  private attempted = new Map<string, string>();
  private ingested = new Map<string, string>();
  private scanning = false;
  private folderError: string | null = null;
  private lastScanAt: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: WatcherDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.tmdb = deps.tmdb;
    this.enqueue = deps.enqueue;
    this.now = deps.now ?? (() => Date.now());
  }

  get dir(): string | null {
    const configured = this.store.settings.watchDir ?? this.config.watchDir ?? '';
    const trimmed = configured.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }

  get enabled(): boolean {
    return this.store.settings.watchEnabled !== false && Boolean(this.dir);
  }

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), Math.max(1000, this.config.watchIntervalMs));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  state(): WatchState {
    const counts: Record<WatchFileStatus, number> = { waiting: 0, queued: 0, unmatched: 0, error: 0 };
    const files = [...this.entries.values()].sort((a, b) => b.at.localeCompare(a.at));
    for (const file of files) counts[file.status] += 1;
    return {
      enabled: this.enabled,
      dir: this.dir,
      scanning: this.scanning,
      folderError: this.folderError,
      intervalMs: this.config.watchIntervalMs,
      minAgeMs: this.config.watchMinAgeMs,
      lastScanAt: this.lastScanAt,
      counts,
      files: files.slice(0, MAX_ENTRIES),
    };
  }

  /** Look at the folder once. `retryUnmatched` ignores the retry back-off. */
  async scan(options: { retryUnmatched?: boolean } = {}): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.lastScanAt = new Date(this.now()).toISOString();
    try {
      const dir = this.dir;
      if (!this.enabled || !dir) {
        this.folderError = null;
        return;
      }
      if (path.resolve(dir) === path.resolve(this.config.uploadsDir) || path.resolve(dir) === path.resolve(this.config.dataDir)) {
        this.folderError = 'the watched folder cannot be the uploads or data folder';
        return;
      }
      let stats: fs.Stats;
      try {
        stats = fs.statSync(dir);
      } catch {
        this.folderError = `the watched folder does not exist: ${dir}`;
        return;
      }
      if (!stats.isDirectory()) {
        this.folderError = `the watched path is not a folder: ${dir}`;
        return;
      }
      this.folderError = null;

      for (const filePath of collectFiles(dir)) {
        const name = path.relative(dir, filePath);
        if (!isVideoFile(name)) continue;
        if (/\bsample\b/i.test(path.basename(name))) continue;
        if (this.active.has(name)) continue;

        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(filePath);
        } catch {
          continue; // vanished between listing and stat
        }
        const fingerprint = `${fileStat.size}:${fileStat.mtimeMs}`;
        // A file that was already queued and is still sitting here (copy mode)
        // must not be queued twice — but a fresh copy of the same name is new work.
        if (this.ingested.get(name) === fingerprint) continue;
        const existing = this.entries.get(name);
        const sameInstance = this.attempted.get(name) === fingerprint;
        const failedBefore = sameInstance && (existing?.status === 'unmatched' || existing?.status === 'error');
        if (failedBefore && existing && !options.retryUnmatched && this.now() - Date.parse(existing.at) < RETRY_UNMATCHED_MS) continue;
        this.attempted.set(name, fingerprint);

        // Windows file timestamps can sit a few milliseconds in the future.
        const age = Math.max(0, this.now() - fileStat.mtimeMs);
        if (fileStat.size === 0 || age < this.config.watchMinAgeMs) {
          this.record(name, {
            size: fileStat.size,
            modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
            status: 'waiting',
            attempts: existing?.attempts ?? 0,
          });
          continue;
        }

        this.active.add(name);
        try {
          await this.ingest(name, filePath, fileStat, existing?.attempts ?? 0);
        } finally {
          this.active.delete(name);
        }
      }

      this.prune();
    } catch (error) {
      // A scan runs from a timer as `void this.scan()`: anything thrown out here
      // would be an unhandled rejection and would end the process. The folder is
      // simply looked at again on the next tick.
      console.error(`[watch] the folder scan failed: ${describeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async ingest(name: string, filePath: string, fileStat: fs.Stats, attempts: number): Promise<void> {
    const parsed = parseReleaseName(path.basename(name));
    try {
      if (!parsed.title) throw new WatchError(`could not read a title from “${path.basename(name)}”`);
      if (parsed.seasonOnly) throw new WatchError('this looks like a whole-season file — rename it with SxxExx episode numbers to queue it');

      const target = await this.resolve(parsed, path.basename(name));
      const tempPath = moveIntoUploads(filePath, this.config.uploadsDir);
      let jobId: string;
      try {
        jobId = this.enqueue(target, tempPath, path.basename(name), fileStat.size).id;
      } catch (error) {
        try {
          fs.renameSync(tempPath, filePath);
        } catch {
          /* leave it in the uploads folder; the startup sweep will collect it */
        }
        throw error;
      }
      this.ingested.set(name, `${fileStat.size}:${fileStat.mtimeMs}`);
      this.record(name, {
        size: fileStat.size,
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
        status: 'queued',
        title: parsed.title,
        target,
        jobId,
        attempts: attempts + 1,
      });
    } catch (error) {
      this.record(name, {
        size: fileStat.size,
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
        status: error instanceof WatchError ? 'unmatched' : 'error',
        title: parsed.title,
        error: describeError(error),
        attempts: attempts + 1,
      });
    }
  }

  /** Confirm a parsed release name against TMDB before anything is queued. */
  private async resolve(parsed: ParsedRelease, fileName: string): Promise<JobTarget> {
    const results = await this.tmdb().search(parsed.title);
    const match = bestMatch(results, parsed);
    if (!match) throw new WatchError(`no confident TMDB match for “${parsed.title}”${parsed.year ? ` (${parsed.year})` : ''}`);

    if (parsed.season !== undefined) {
      const season = parsed.season as number;
      const episodeNumber = parsed.episode as number;
      const show = await this.tmdb().tv(match.tmdbId);
      if (!show.seasons.some((entry) => entry.seasonNumber === season)) {
        throw new WatchError(`TMDB has no season ${season} of “${show.title}”`);
      }
      const episodes = await this.tmdb().season(show.tmdbId, season);
      const episode = episodes.find((entry) => entry.episodeNumber === episodeNumber);
      if (!episode) throw new WatchError(`TMDB has no S${String(season).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')} of “${show.title}”`);
      const target: JobTarget = {
        kind: 'episode',
        tmdbId: show.tmdbId,
        title: show.title,
        season,
        episode: episodeNumber,
      };
      if (show.year) target.year = show.year;
      if (show.posterPath) target.posterPath = show.posterPath;
      target.episodeTitle = episode.name;
      return target;
    }

    const movie = await this.tmdb().movie(match.tmdbId);
    const target: JobTarget = { kind: 'movie', tmdbId: movie.tmdbId, title: movie.title };
    if (movie.year) target.year = movie.year;
    if (movie.posterPath) target.posterPath = movie.posterPath;
    return target;
  }

  private record(
    name: string,
    update: { size: number; modifiedAt: string; status: WatchFileStatus; title?: string; target?: JobTarget; jobId?: string; error?: string; attempts: number },
  ): void {
    const entry: WatchFileView = {
      name,
      size: update.size,
      modifiedAt: update.modifiedAt,
      status: update.status,
      attempts: update.attempts,
      at: new Date(this.now()).toISOString(),
    };
    if (update.title) entry.title = update.title;
    if (update.target) entry.target = update.target;
    if (update.jobId) entry.jobId = update.jobId;
    if (update.error) entry.error = update.error;
    this.entries.set(name, entry);
  }

  /** Forget files that are gone unless they were queued (those left on purpose). */
  private prune(): void {
    const dir = this.dir;
    if (!dir) return;
    const gone: string[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.status === 'queued') {
        if (this.entries.size > MAX_ENTRIES) gone.push(name);
        continue;
      }
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) gone.push(name);
    }
    for (const name of gone) this.entries.delete(name);

    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.values()]
      .filter((entry) => entry.status === 'queued')
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, this.entries.size - MAX_ENTRIES);
    for (const entry of oldest) this.entries.delete(entry.name);
  }
}
