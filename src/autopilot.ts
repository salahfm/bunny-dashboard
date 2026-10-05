/**
 * The autopilot: walk TMDB's top-rated lists and queue what is worth queueing,
 * without anyone clicking.
 *
 * The rule the dashboard promises is "the best first": TMDB's `/movie/top_rated`
 * and `/tv/top_rated` are read page by page, each page is processed highest
 * rating first, and a title is only queued when it clears a rating floor — no
 * rating at all counts as failing it, because a title nobody has rated is not
 * what "top rated" means. Titles already queued or already published are stepped
 * over, so re-reading a page is free.
 *
 * When a cycle finds nothing new to queue it automatically retries the failed
 * jobs — a bad night of sources is exactly what a list-wide retry is for — and
 * when there is nothing to retry either, it starts the list over from page one
 * so anything that gained a rating since is picked up. That is the whole loop:
 * fill the queue from the top, then clean up what fell over, then look again.
 *
 * State (the cursor per list, the last report and the counters) lives in
 * `DATA_DIR/autopilot.json` so a restart resumes where it stopped instead of
 * re-walking the same pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { planShow } from './bulk';
import type { AppConfig } from './config';
import type { Job, JobTarget, Store } from './store';
import { targetKey } from './store';
import type { TmdbClient, TmdbSearchResult } from './tmdb';

export type AutopilotKind = 'movie' | 'tv';

export interface AutopilotConfig {
  enabled: boolean;
  /** A title must be rated at least this to be queued; a missing rating fails. */
  minRating: number;
  /** Which lists to walk. */
  kinds: AutopilotKind[];
  /** The scrape's minimum tier (0 = whatever the host has). */
  minHeight: number;
  /** Hosts to scrape (provider ids); empty means every host. */
  only?: string[];
  /** Queue every episode of a show rather than skipping shows. */
  expandSeries: boolean;
  /** How many jobs one cycle may create. */
  maxJobsPerCycle: number;
  /** A failed job is retried until it has been attempted this many times. */
  maxAttempts: number;
  /** Stop adding while the queue already holds this many unfinished jobs. */
  maxQueueDepth: number;
  /** How often a cycle runs. */
  intervalMs: number;
}

export const AUTOPILOT_DEFAULTS: AutopilotConfig = {
  enabled: false,
  minRating: 3,
  kinds: ['movie', 'tv'],
  minHeight: 1080,
  expandSeries: true,
  maxJobsPerCycle: 25,
  maxAttempts: 5,
  maxQueueDepth: 300,
  intervalMs: 5 * 60_000,
};

/** TMDB refuses pages past 500, so that is where a list wrap is forced. */
export const AUTOPILOT_MAX_PAGE = 500;

export class AutopilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutopilotError';
  }
}

export interface AutopilotReport {
  cycle: number;
  startedAt: string;
  finishedAt: string;
  /** Titles looked at on the pages walked. */
  scanned: number;
  /** Jobs created. */
  created: number;
  /** Titles stepped over for a missing or too-low rating. */
  belowRating: number;
  /** Titles already queued or already published. */
  alreadyDone: number;
  /** Failed jobs handed back to the queue. */
  retried: number;
  /** Failed jobs left alone: they have already been tried enough. */
  abandoned: number;
  /** The list started over (end reached, or nothing left to do). */
  wrapped: boolean;
  /** The cycle did not run because the queue is already deep. */
  paused: boolean;
  note: string;
  /** Why individual titles were stepped over (capped). */
  skipped: Array<{ title: string; reason: string }>;
}

export interface AutopilotState {
  config: AutopilotConfig;
  cycle: number;
  running: boolean;
  cursors: Record<AutopilotKind, number>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastReport: AutopilotReport | null;
  /** How many titles are already queued or published (the autopilot's baseline). */
  done: number;
  /** How many unfinished jobs are in the queue right now. */
  queueDepth: number;
  log: string[];
}

/** What the autopilot needs from the job service. */
export interface AutopilotJobs {
  createStreamJob(target: JobTarget, options: { mode: 'scrape'; minHeight?: number; only?: string[] }): Job;
  retry(jobId: string): Job | undefined;
}

export interface AutopilotDeps {
  config: AppConfig;
  store: Store;
  jobs: AutopilotJobs;
  tmdb: () => TmdbClient;
  /** Every target already queued or in the published catalogue. */
  doneKeys: () => Set<string>;
  now?: () => number;
  log?: (message: string) => void;
}

interface PersistedState {
  version: 1;
  config: AutopilotConfig;
  cycle: number;
  cursors: Record<AutopilotKind, number>;
  lastRunAt: string | null;
  lastReport: AutopilotReport | null;
  log: string[];
}

const MAX_LOG_LINES = 200;
const MAX_SKIPPED = 40;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** A movie entry from a search result, as the pipeline's target shape. */
function movieTarget(entry: TmdbSearchResult): JobTarget {
  const target: JobTarget = { kind: 'movie', tmdbId: entry.tmdbId, title: entry.title };
  if (entry.year) target.year = entry.year;
  if (entry.posterPath) target.posterPath = entry.posterPath;
  return target;
}

export class Autopilot {
  private config: AppConfig;
  private store: Store;
  private jobs: AutopilotJobs;
  private tmdb: () => TmdbClient;
  private doneKeys: () => Set<string>;
  private now: () => number;
  private logLine: (message: string) => void;
  private state: PersistedState;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(deps: AutopilotDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.jobs = deps.jobs;
    this.tmdb = deps.tmdb;
    this.doneKeys = deps.doneKeys;
    this.now = deps.now ?? (() => Date.now());
    this.logLine = deps.log ?? ((message) => console.log(message));
    this.state = this.load();
  }

  private get filePath(): string {
    return path.join(this.config.dataDir, 'autopilot.json');
  }

  /** Saved state, with the defaults under it so a new field always has a value. */
  private load(): PersistedState {
    const base: PersistedState = {
      version: 1,
      config: { ...AUTOPILOT_DEFAULTS },
      cycle: 0,
      cursors: { movie: 1, tv: 1 },
      lastRunAt: null,
      lastReport: null,
      log: [],
    };
    let raw: Partial<PersistedState>;
    try {
      if (!fs.existsSync(this.filePath)) return base;
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedState>;
    } catch {
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return base;
    }
    return {
      version: 1,
      config: { ...AUTOPILOT_DEFAULTS, ...(raw.config ?? {}) },
      cycle: clampNumber(raw.cycle, 0, 0, Number.MAX_SAFE_INTEGER),
      cursors: {
        movie: clampNumber(raw.cursors?.movie, 1, 1, AUTOPILOT_MAX_PAGE),
        tv: clampNumber(raw.cursors?.tv, 1, 1, AUTOPILOT_MAX_PAGE),
      },
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
      lastReport: raw.lastReport ?? null,
      log: Array.isArray(raw.log) ? raw.log.filter((line): line is string => typeof line === 'string').slice(-MAX_LOG_LINES) : [],
    };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logLine(`[autopilot] could not save its state: ${describeError(error)}`);
    }
  }

  private append(message: string): void {
    const line = `${new Date(this.now()).toISOString()} ${message}`;
    this.state.log.push(line);
    if (this.state.log.length > MAX_LOG_LINES) this.state.log.splice(0, this.state.log.length - MAX_LOG_LINES);
    this.logLine(`[autopilot] ${message}`);
  }

  /** The unfinished queue, which is what `maxQueueDepth` guards. */
  private queueDepth(): number {
    return this.store.jobs.filter((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'encoding').length;
  }

  stateView(): AutopilotState {
    return {
      config: { ...this.state.config },
      cycle: this.state.cycle,
      running: this.running,
      cursors: { ...this.state.cursors },
      lastRunAt: this.state.lastRunAt,
      nextRunAt: this.nextRunAt(),
      lastReport: this.state.lastReport,
      done: this.doneKeys().size,
      queueDepth: this.queueDepth(),
      log: [...this.state.log].reverse(),
    };
  }

  private nextRunAt(): string | null {
    if (!this.state.config.enabled) return null;
    if (this.running) return null;
    return new Date(this.now() + this.state.config.intervalMs).toISOString();
  }

  /** Validates and stores a config patch; throws AutopilotError on nonsense. */
  updateConfig(patch: Record<string, unknown>): AutopilotState {
    const config: AutopilotConfig = { ...this.state.config };

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new AutopilotError('enabled must be true or false');
      config.enabled = patch.enabled;
    }
    if (patch.minRating !== undefined) {
      const value = Number(patch.minRating);
      if (!Number.isFinite(value) || value < 0 || value > 10) throw new AutopilotError('the rating floor must be between 0 and 10');
      config.minRating = value;
    }
    if (patch.kinds !== undefined) {
      if (!Array.isArray(patch.kinds)) throw new AutopilotError('kinds must be a list of "movie" and/or "tv"');
      const kinds = patch.kinds.filter((kind): kind is AutopilotKind => kind === 'movie' || kind === 'tv');
      if (!kinds.length) throw new AutopilotError('pick at least one list (movies or shows)');
      config.kinds = [...new Set(kinds)];
    }
    if (patch.minHeight !== undefined) {
      const value = Number(patch.minHeight);
      if (!Number.isFinite(value) || value < 0 || value > 4320) throw new AutopilotError('the minimum tier must be between 0 and 4320');
      config.minHeight = Math.floor(value);
    }
    if (patch.only !== undefined) {
      if (!Array.isArray(patch.only)) throw new AutopilotError('only must be a list of host ids');
      const only = patch.only.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim());
      if (only.length) config.only = only;
      else delete config.only;
    }
    if (patch.expandSeries !== undefined) {
      if (typeof patch.expandSeries !== 'boolean') throw new AutopilotError('expandSeries must be true or false');
      config.expandSeries = patch.expandSeries;
    }
    if (patch.maxJobsPerCycle !== undefined) {
      const value = Number(patch.maxJobsPerCycle);
      if (!Number.isFinite(value) || value < 1 || value > 500) throw new AutopilotError('jobs per cycle must be between 1 and 500');
      config.maxJobsPerCycle = Math.floor(value);
    }
    if (patch.maxAttempts !== undefined) {
      const value = Number(patch.maxAttempts);
      if (!Number.isFinite(value) || value < 1 || value > 20) throw new AutopilotError('the retry limit must be between 1 and 20');
      config.maxAttempts = Math.floor(value);
    }
    if (patch.maxQueueDepth !== undefined) {
      const value = Number(patch.maxQueueDepth);
      if (!Number.isFinite(value) || value < 1 || value > 10_000) throw new AutopilotError('the queue-depth pause must be between 1 and 10000');
      config.maxQueueDepth = Math.floor(value);
    }
    if (patch.intervalMs !== undefined) {
      const value = Number(patch.intervalMs);
      if (!Number.isFinite(value) || value < 10_000 || value > 86_400_000) throw new AutopilotError('the interval must be between 10 s and 24 h');
      config.intervalMs = Math.floor(value);
    }

    const wasEnabled = this.state.config.enabled;
    this.state.config = config;
    if (config.enabled && !wasEnabled) {
      this.append('switched on');
      this.start();
    } else if (!config.enabled && wasEnabled) {
      this.append('switched off');
    }
    this.save();
    return this.stateView();
  }

  /** Clears the page cursors so the next cycle starts at the top again. */
  reset(): AutopilotState {
    this.state.cursors = { movie: 1, tv: 1 };
    this.state.cycle = 0;
    this.append('cursors reset to page 1');
    this.save();
    return this.stateView();
  }

  clearLog(): AutopilotState {
    this.state.log = [];
    this.save();
    return this.stateView();
  }

  /** Checks every `tickMs` whether a cycle is due (so a config change applies). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.save();
  }

  private async tick(): Promise<void> {
    if (!this.state.config.enabled || this.running) return;
    const dueAt = this.state.lastRunAt
      ? Date.parse(this.state.lastRunAt) + this.state.config.intervalMs
      : 0;
    if (this.now() < dueAt) return;
    await this.runCycle().catch((error) => this.append(`cycle failed: ${describeError(error)}`));
  }

  private finish(report: AutopilotReport): AutopilotReport {
    report.finishedAt = new Date(this.now()).toISOString();
    this.state.cycle = report.cycle;
    this.state.lastRunAt = report.finishedAt;
    this.state.lastReport = report;
    const parts = [`cycle ${report.cycle}`];
    if (report.paused) parts.push(`paused: ${report.note}`);
    else {
      parts.push(`queued ${report.created}`);
      if (report.scanned) parts.push(`scanned ${report.scanned}`);
      if (report.belowRating) parts.push(`${report.belowRating} below the rating floor`);
      if (report.alreadyDone) parts.push(`${report.alreadyDone} already done`);
      if (report.retried) parts.push(`retried ${report.retried}`);
      if (report.abandoned) parts.push(`${report.abandoned} given up on`);
      if (report.wrapped) parts.push('restarted the list');
      if (report.note) parts.push(report.note);
    }
    this.append(parts.join(' · '));
    this.save();
    return report;
  }

  private note(report: AutopilotReport, title: string, reason: string): void {
    if (report.skipped.length < MAX_SKIPPED) report.skipped.push({ title, reason });
  }

  /** One pass over the top-rated lists: queue what clears the floor, then retry. */
  async runCycle(): Promise<AutopilotReport> {
    const startedAt = new Date(this.now()).toISOString();
    const report: AutopilotReport = {
      cycle: this.state.cycle + 1,
      startedAt,
      finishedAt: startedAt,
      scanned: 0,
      created: 0,
      belowRating: 0,
      alreadyDone: 0,
      retried: 0,
      abandoned: 0,
      wrapped: false,
      paused: false,
      note: '',
      skipped: [],
    };

    if (!this.state.config.enabled) {
      report.note = 'autopilot is switched off';
      return this.finish(report);
    }
    if (this.running) {
      report.note = 'a cycle is already running';
      return this.finish(report);
    }
    const depth = this.queueDepth();
    if (depth >= this.state.config.maxQueueDepth) {
      report.paused = true;
      report.note = `the queue already holds ${depth} unfinished job(s)`;
      return this.finish(report);
    }

    this.running = true;
    try {
      const config = this.state.config;
      const done = this.doneKeys();
      let client: TmdbClient;
      try {
        client = this.tmdb();
      } catch (error) {
        report.note = describeError(error);
        return this.finish(report);
      }

      let remaining = config.maxJobsPerCycle;
      for (const kind of config.kinds) {
        while (remaining > 0) {
          const page = this.state.cursors[kind];
          if (page > AUTOPILOT_MAX_PAGE) {
            this.state.cursors[kind] = 1;
            report.wrapped = true;
            report.note = `the ${kind} list hit TMDB's page cap — starting over`;
            break;
          }
          let top;
          try {
            top = await client.topRated(kind, page);
          } catch (error) {
            report.note = `could not read the TMDB top-rated ${kind} list: ${describeError(error)}`;
            break;
          }
          if (!top.results.length || page > top.totalPages) {
            this.state.cursors[kind] = 1;
            report.wrapped = true;
            break;
          }

          let consumedPage = true;
          for (const entry of top.results) {
            if (remaining <= 0) {
              consumedPage = false;
              break;
            }
            report.scanned += 1;
            const rating = entry.voteAverage;
            if (rating === undefined || !Number.isFinite(rating) || rating < config.minRating) {
              report.belowRating += 1;
              this.note(
                report,
                entry.title,
                rating === undefined || !Number.isFinite(rating) ? 'no rating yet' : `rated ${rating}, below ${config.minRating}`,
              );
              continue;
            }
            let targets: JobTarget[];
            try {
              targets = await this.expand(entry, kind, client);
            } catch (error) {
              this.note(report, entry.title, describeError(error));
              continue;
            }
            if (!targets.length) {
              this.note(report, entry.title, 'nothing to queue');
              continue;
            }
            for (const target of targets) {
              if (remaining <= 0) {
                consumedPage = false;
                break;
              }
              const key = targetKey(target);
              if (done.has(key)) {
                report.alreadyDone += 1;
                continue;
              }
              this.jobs.createStreamJob(target, {
                mode: 'scrape',
                minHeight: config.minHeight,
                ...(config.only && config.only.length ? { only: config.only } : {}),
              });
              done.add(key);
              remaining -= 1;
              report.created += 1;
            }
            if (!consumedPage) break;
          }

          // The cursor only moves once the page is fully dealt with, so a page
          // cut short by the per-cycle cap is picked up again next cycle.
          if (!consumedPage) break;
          this.state.cursors[kind] = page + 1;
        }
        if (remaining <= 0) break;
      }

      if (report.created === 0 && !report.paused) {
        const retry = this.retryFailed();
        report.retried = retry.retried;
        report.abandoned = retry.abandoned;
        if (report.retried === 0) {
          // Nothing to add and nothing to retry: start over, so a title that has
          // gained a rating (or appeared on a new page) is seen next time.
          this.state.cursors = { movie: 1, tv: 1 };
          report.wrapped = true;
          if (!report.note) report.note = report.belowRating ? 'every title seen was below the rating floor or already done' : 'nothing new to queue';
        } else {
          report.note = `nothing new — retried ${report.retried} failed job(s) instead`;
        }
      }
      return this.finish(report);
    } finally {
      this.running = false;
    }
  }

  /** A top-rated entry becomes the jobs it stands for. */
  private async expand(entry: TmdbSearchResult, kind: AutopilotKind, client: TmdbClient): Promise<JobTarget[]> {
    if (kind === 'movie') return [movieTarget(entry)];
    if (!this.state.config.expandSeries) throw new Error('it is a show and series expansion is switched off');
    // Every episode of every season, the same expansion the bulk add uses.
    return planShow(client, entry.tmdbId);
  }

  /** Hands the failed jobs back to the queue, up to the attempt limit. */
  private retryFailed(): { retried: number; abandoned: number } {
    let retried = 0;
    let abandoned = 0;
    const failed = this.store.jobs
      .filter((job) => job.status === 'failed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of failed) {
      if ((job.attempts ?? 0) >= this.state.config.maxAttempts) {
        abandoned += 1;
        continue;
      }
      if (this.jobs.retry(job.id)) retried += 1;
    }
    return { retried, abandoned };
  }
}
