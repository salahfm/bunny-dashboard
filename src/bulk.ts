/**
 * Bulk queuing: a pasted list becomes a queue.
 *
 * Each line is something the search box accepts — a title, a TMDB id, an IMDb
 * id, a themoviedb.org link — plus the release-style decorations the watched
 * folder already understands (`Movie (2010)`, `Breaking Bad S03`,
 * `Show S02E05`). Matching is shared with the watcher (`parseReleaseName`,
 * `bestMatch`), so a list of two hundred titles fails on exactly the lines a
 * filename would: the ones TMDB cannot confidently place.
 *
 * Planning and queueing are separate on purpose. This module only talks to TMDB
 * and produces targets; the caller decides which of them already have a job and
 * creates the rest. That keeps "what does this line mean" testable without a
 * store, a queue or a Bunny account.
 */
import { targetKey, type Job, type JobTarget } from './store';

// Re-exported for callers that already reach for it here (and its tests).
export { targetKey };
import { TmdbError, lookupTmdb, type TmdbClient, type TmdbEpisode, type TmdbSearchResult } from './tmdb';
import { bestMatch, parseReleaseName } from './watch';

/** How many jobs one paste may create before the rest of the list is left alone. */
export const DEFAULT_MAX_BULK_JOBS = 200;

export interface PlannedTarget {
  /** The line that produced this target, for the report. */
  line: string;
  target: JobTarget;
}

export interface BulkPlan {
  queued: PlannedTarget[];
  skipped: Array<{ line: string; reason: string }>;
  truncated: boolean;
}

export interface BulkOptions {
  /** Expand a show into every episode (default). Off means shows are skipped. */
  expandSeries?: boolean;
  /** Limit every show in the list to these seasons; a line's own `S03` wins. */
  seasons?: number[];
  maxJobs?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The keys of every job that is either in the queue or already published.
 *
 * Failed and cancelled jobs are deliberately left out: queueing a title again
 * after an attempt fell over is how an operator retries a batch, and refusing it
 * as "already queued" would leave them clicking job by job.
 */
export function queuedKeys(jobs: Job[]): Set<string> {
  return new Set(
    jobs
      .filter((job) => job.status !== 'failed' && job.status !== 'cancelled')
      .map((job) => targetKey(job.target)),
  );
}

/**
 * Drops the planned targets that are already in the queue.
 *
 * `keys` is updated as it goes, so one batch cannot queue the same episode twice
 * when two lines resolve to it. The set is the caller's — the store's keys with
 * this run's additions on top.
 */
export function withoutQueued(
  planned: PlannedTarget[],
  keys: Set<string>,
): { fresh: PlannedTarget[]; skipped: Array<{ line: string; reason: string }> } {
  const fresh: PlannedTarget[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];
  for (const entry of planned) {
    const key = targetKey(entry.target);
    if (keys.has(key)) {
      skipped.push({ line: entry.line, reason: 'already in the queue' });
      continue;
    }
    keys.add(key);
    fresh.push(entry);
  }
  return { fresh, skipped };
}

/** `Breaking Bad S03` / `Breaking Bad season 3` pins one season. */
export function seasonFromLine(line: string): number | undefined {
  const match = /\bs(?:eason\s*)?(\d{1,2})\s*$/i.exec(line.trim());
  if (!match?.[1]) return undefined;
  const season = Number(match[1]);
  return Number.isFinite(season) && season > 0 ? season : undefined;
}

/** A line that carries its own reference: an id, an IMDb id, or a link. */
function isReference(line: string): boolean {
  return /^(tt\d+|\d+|https?:\/\/)/i.test(line);
}

/**
 * One line → one TMDB entry.
 *
 * A line that carries an id or a link is taken literally (TMDB is asked what it
 * is, and a miss is an error rather than a guess); a plain name is searched and
 * only accepted at the watcher's confidence threshold.
 */
export async function resolveLine(client: TmdbClient, line: string): Promise<TmdbSearchResult> {
  const trimmed = line.trim();
  if (isReference(trimmed)) {
    const results = await lookupTmdb(client, trimmed);
    const first = results[0];
    if (!first) throw new TmdbError(`TMDB has nothing for ${trimmed}`, 404);
    return first;
  }
  const parsed = parseReleaseName(trimmed);
  const query = parsed.title || trimmed;
  const match = bestMatch(await client.search(query), parsed);
  if (!match) throw new TmdbError(`no confident TMDB match for “${query}”`, 404);
  return match;
}

function movieTarget(entry: TmdbSearchResult): JobTarget {
  const target: JobTarget = { kind: 'movie', tmdbId: entry.tmdbId, title: entry.title };
  if (entry.year) target.year = entry.year;
  if (entry.posterPath) target.posterPath = entry.posterPath;
  return target;
}

function episodeTarget(
  show: { tmdbId: number; title: string; year?: string | undefined; posterPath?: string | null | undefined },
  season: number,
  episode: TmdbEpisode,
): JobTarget {
  const target: JobTarget = {
    kind: 'episode',
    tmdbId: show.tmdbId,
    title: show.title,
    season,
    episode: episode.episodeNumber,
  };
  if (show.year) target.year = show.year;
  if (show.posterPath) target.posterPath = show.posterPath;
  if (episode.name) target.episodeTitle = episode.name;
  return target;
}

/**
 * Every episode of a show — one season or all of them.
 *
 * Each season is read from TMDB (so the episode list is exact, not the coarse
 * `episode_count`), and specials (season 0) are never included: they are not
 * part of a series run and hosts would not have them in order anyway.
 */
export async function planShow(client: TmdbClient, tmdbId: number, options: { seasons?: number[] } = {}): Promise<JobTarget[]> {
  const show = await client.tv(tmdbId);
  const wanted = options.seasons?.length
    ? show.seasons.filter((season) => options.seasons?.includes(season.seasonNumber))
    : show.seasons;
  if (!wanted.length) {
    const asked = options.seasons?.length ? `season ${options.seasons.join('/')} of ` : '';
    throw new TmdbError(`TMDB has no ${asked}“${show.title}”`, 404);
  }
  const targets: JobTarget[] = [];
  for (const season of wanted) {
    const episodes = await client.season(show.tmdbId, season.seasonNumber);
    for (const episode of episodes) targets.push(episodeTarget(show, season.seasonNumber, episode));
  }
  if (!targets.length) throw new TmdbError(`TMDB lists no episodes for “${show.title}”`, 404);
  return targets;
}

/** One resolved entry → the jobs it stands for. */
async function targetsForEntry(
  client: TmdbClient,
  entry: TmdbSearchResult,
  options: { expandSeries: boolean; season?: number; episode?: number; seasons?: number[] },
): Promise<JobTarget[]> {
  if (entry.mediaType === 'movie') {
    // A line that named an episode but resolved to a film is a typo, not a movie.
    if (options.season !== undefined && options.episode !== undefined) {
      throw new TmdbError(`“${entry.title}” is a movie, so S${pad(options.season)}E${pad(options.episode)} means nothing`, 400);
    }
    return [movieTarget(entry)];
  }
  if (!options.expandSeries) {
    throw new TmdbError(`“${entry.title}” is a show and series expansion is switched off`, 400);
  }
  // A line that names one episode is one job — and the episode is confirmed to
  // exist, so a typo is reported instead of queued as something else.
  if (options.season !== undefined && options.episode !== undefined) {
    const episodes = await client.season(entry.tmdbId, options.season);
    const match = episodes.find((episode) => episode.episodeNumber === options.episode);
    if (!match) {
      throw new TmdbError(`TMDB has no S${pad(options.season)}E${pad(options.episode)} of “${entry.title}”`, 404);
    }
    return [episodeTarget(entry, options.season, match)];
  }
  return planShow(client, entry.tmdbId, options.seasons?.length ? { seasons: options.seasons } : {});
}

/**
 * A pasted list → the jobs it should create, plus what could not be planned.
 *
 * Blank lines are ignored and `#` comments a line out, so a list can be kept as
 * a file and edited between runs.
 */
export async function planBulk(client: TmdbClient, lines: string[], options: BulkOptions = {}): Promise<BulkPlan> {
  const requested = Number(options.maxJobs);
  const maxJobs = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_BULK_JOBS;
  const expandSeries = options.expandSeries !== false;
  const queued: PlannedTarget[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];
  let truncated = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (queued.length >= maxJobs) {
      truncated = true;
      break;
    }
    try {
      const parsed = parseReleaseName(line);
      const pinned = seasonFromLine(line);
      const seasons = pinned !== undefined ? [pinned] : options.seasons;
      const entry = await resolveLine(client, line);
      const targets = await targetsForEntry(client, entry, {
        expandSeries,
        ...(parsed.season !== undefined ? { season: parsed.season } : {}),
        ...(parsed.episode !== undefined ? { episode: parsed.episode } : {}),
        ...(seasons?.length ? { seasons } : {}),
      });
      for (const target of targets) {
        if (queued.length >= maxJobs) {
          truncated = true;
          break;
        }
        queued.push({ line, target });
      }
    } catch (error) {
      skipped.push({ line, reason: describeError(error) });
    }
  }
  return { queued, skipped, truncated };
}
