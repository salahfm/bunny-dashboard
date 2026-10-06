/**
 * The automatic verification pass.
 *
 * An archive is only worth having if it is still the thing it claims to be, and
 * a check that only runs when somebody presses a button is a check that stops
 * happening. So this is the *schedule* half of verification: once a week (by
 * default) it puts every archived title through the same verification pass the
 * Library button runs, which refreshes each record's `verifiedAt` and its
 * verdict, and surfaces — in the log, in the counts and on the rows — anything
 * that stopped matching.
 *
 * The state lives in its own JSON file next to `db.json`, like the autopilot's,
 * so "when did this last run?" and "what did it find?" survive a restart. The
 * environment only supplies the *defaults* (`R2_VERIFY`, `R2_VERIFY_INTERVAL_MS`);
 * once the schedule has been changed from the dashboard, that choice is the one
 * that is kept.
 *
 * A sweep does not block anything. It puts the titles in line and returns; the
 * archive's own queue does the reading one title at a time, the browser watches
 * it on the event stream, and the sweep is only marked finished once that queue
 * has gone quiet — at which point the verdicts are counted and written to the
 * log. A library larger than one batch is walked in waves, one settled wave at a
 * time, so a single sweep still reaches every title without flooding the queue.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveCandidate, ArchiveEnqueueReport } from './archive';
import type { Catalog } from './catalog';
import type { AppConfig } from './config';

/** The narrow slice of the archive service a sweep needs. */
export interface CheckScheduleArchive {
  readonly configured: boolean;
  /** Every archived title that could be re-read, which is the sweep's work list. */
  verifyCandidates(): ArchiveCandidate[];
  /** Puts titles in line; the same call the Library button makes. */
  enqueueKeys(keys: string[], limit: number, operation: 'verify'): ArchiveEnqueueReport;
  /** Queued plus in-flight tasks — zero means a wave has been worked through. */
  readonly busy: number;
}

export interface CheckScheduleConfig {
  enabled: boolean;
  /** How often a sweep runs. */
  intervalMs: number;
  /** How many titles one wave puts in line; the next wave follows the first. */
  batchSize: number;
}

/** Where the schedule sits by default: a weekly pass over everything in R2. */
export const CHECK_DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const CHECK_MIN_INTERVAL_MS = 60 * 60_000;
export const CHECK_MAX_INTERVAL_MS = 30 * 24 * 60 * 60_000;
export const CHECK_DEFAULT_BATCH = 250;
export const CHECK_MAX_BATCH = 5_000;

/**
 * How long a sweep may stay open. A queue that never goes quiet (a stalled
 * transfer, say) must not leave the schedule wedged forever.
 */
const MAX_SWEEP_MS = 24 * 60 * 60_000;

/** The lines kept for the Settings log, newest first when read. */
const MAX_LOG_LINES = 200;

export class CheckScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckScheduleError';
  }
}

/** What one sweep did, and what it found. */
export interface CheckSweepReport {
  startedAt: string;
  finishedAt: string;
  /** Titles this sweep put in line. */
  queued: number;
  /** Titles that were already being checked, or could not be queued. */
  skipped: number;
  /** Titles that came back matching their manifest. */
  passing: number;
  /** Titles that came back missing objects or with changed ones. */
  failing: number;
  /** Titles that never produced a verdict (skipped mid-run, or the sweep gave up). */
  unfinished: number;
  /** The titles that stopped matching, so a caller can name them. */
  failingKeys: string[];
  /** The titles that were never queued, when a sweep ran out of time. */
  pendingKeys?: string[];
  note: string;
}

/** What the archive holds right now — the numbers a schedule is judged by. */
export interface CheckTotals {
  /** Titles with an archive record. */
  archived: number;
  /** Titles that have been checked at least once. */
  checked: number;
  /** Titles whose last check found something wrong. */
  failing: number;
  /** Titles nothing has ever checked. */
  never: number;
}

export interface CheckScheduleState {
  config: CheckScheduleConfig;
  /** A sweep is in line or being worked through. */
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastSweep: CheckSweepReport | null;
  totals: CheckTotals;
  log: string[];
}

interface PersistedState {
  version: 1;
  config: CheckScheduleConfig;
  lastRunAt: string | null;
  lastSweep: CheckSweepReport | null;
  log: string[];
}

export interface CheckScheduleDeps {
  config: AppConfig;
  catalog: Catalog;
  archive: CheckScheduleArchive;
  now?: () => number;
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ArchiveCheckSchedule {
  private deps: CheckScheduleDeps;
  private now: () => number;
  private logLine: (message: string) => void;
  private state: PersistedState;
  private timer: NodeJS.Timeout | undefined;
  /**
   * The sweep in flight: what it must still queue, what it has queued, and when
   * it started. All of it is about *this* process, so it is deliberately not
   * persisted — a restart mid-sweep simply tries again on its next tick.
   */
  private pending: { startedAt: string; queue: string[]; started: string[]; skipped: number } | undefined;

  constructor(deps: CheckScheduleDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.logLine = deps.log ?? ((message) => console.log(message));
    this.state = this.load();
  }

  private get filePath(): string {
    return path.join(this.deps.config.dataDir, 'archive-check.json');
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Saved state with the environment's defaults underneath it.
   *
   * The defaults come from `R2_VERIFY` / `R2_VERIFY_INTERVAL_MS`, but only for a
   * schedule that has never been changed from the dashboard: once it has, the
   * stored choice wins, exactly like the archive's own on/off switch.
   */
  private load(): PersistedState {
    const base: PersistedState = {
      version: 1,
      config: {
        enabled: this.deps.config.r2?.verify ?? true,
        intervalMs: this.deps.config.r2?.verifyIntervalMs ?? CHECK_DEFAULT_INTERVAL_MS,
        batchSize: CHECK_DEFAULT_BATCH,
      },
      lastRunAt: null,
      lastSweep: null,
      log: [],
    };
    let raw: Partial<PersistedState>;
    try {
      if (!fs.existsSync(this.filePath)) return base;
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedState>;
    } catch {
      // A schedule that cannot be parsed must not stop the dashboard.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* the rename is best effort */
      }
      return base;
    }
    const config: Partial<CheckScheduleConfig> = raw.config ?? {};
    return {
      version: 1,
      config: {
        enabled: typeof config.enabled === 'boolean' ? config.enabled : base.config.enabled,
        intervalMs: clampCheckInterval(config.intervalMs, base.config.intervalMs),
        batchSize: clampBatch(config.batchSize, base.config.batchSize),
      },
      lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
      lastSweep: raw.lastSweep ?? null,
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
      this.logLine(`[check] could not save the schedule: ${describeError(error)}`);
    }
  }

  private append(message: string): void {
    this.state.log.push(`${this.nowIso()} ${message}`);
    if (this.state.log.length > MAX_LOG_LINES) this.state.log.splice(0, this.state.log.length - MAX_LOG_LINES);
    this.logLine(`[check] ${message}`);
  }

  /* ---------------------------------------------------------------- */
  /* What the dashboard reads                                          */
  /* ---------------------------------------------------------------- */

  /**
   * The archive as it stands: how many titles are in R2, how many have a
   * verdict, and how many stopped matching.
   *
   * This is the "surfaced" half of the request — a count anybody can look at
   * without pressing anything, and one that a weekly sweep keeps honest.
   */
  totals(): CheckTotals {
    let archived = 0;
    let checked = 0;
    let failing = 0;
    for (const entry of this.deps.catalog.all()) {
      if (!entry.archive) continue;
      archived += 1;
      if (entry.archive.verify) {
        checked += 1;
        if (!entry.archive.verify.ok) failing += 1;
      }
    }
    return { archived, checked, failing, never: archived - checked };
  }

  stateView(): CheckScheduleState {
    return {
      config: { ...this.state.config },
      running: this.pending !== undefined,
      lastRunAt: this.state.lastRunAt,
      nextRunAt: this.nextRunAt(),
      lastSweep: this.state.lastSweep,
      totals: this.totals(),
      log: [...this.state.log].reverse(),
    };
  }

  /**
   * When the next sweep is due.
   *
   * Counted from when the last sweep *started*, not from when it finished: a
   * big library should not push its own next check further out the longer it
   * takes to read. An already-overdue schedule answers "now", which is what it
   * means — the next tick picks it up.
   */
  private nextRunAt(): string | null {
    if (!this.state.config.enabled) return null;
    if (this.pending) return null;
    if (!this.deps.archive.configured) return null;
    const due = this.state.lastRunAt ? Date.parse(this.state.lastRunAt) + this.state.config.intervalMs : this.now();
    return new Date(Math.max(due, this.now())).toISOString();
  }

  /** Validates and stores a config patch; throws CheckScheduleError on nonsense. */
  updateConfig(patch: Record<string, unknown>): CheckScheduleState {
    const config: CheckScheduleConfig = { ...this.state.config };
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new CheckScheduleError('enabled must be true or false');
      config.enabled = patch.enabled;
    }
    if (patch.intervalMs !== undefined) {
      const value = Number(patch.intervalMs);
      if (!Number.isFinite(value) || value < CHECK_MIN_INTERVAL_MS || value > CHECK_MAX_INTERVAL_MS) {
        throw new CheckScheduleError('the interval must be between 1 hour and 30 days');
      }
      config.intervalMs = Math.floor(value);
    }
    if (patch.batchSize !== undefined) {
      const value = Number(patch.batchSize);
      if (!Number.isFinite(value) || value < 1 || value > CHECK_MAX_BATCH) {
        throw new CheckScheduleError(`titles per pass must be between 1 and ${CHECK_MAX_BATCH}`);
      }
      config.batchSize = Math.floor(value);
    }
    const wasEnabled = this.state.config.enabled;
    this.state.config = config;
    if (config.enabled !== wasEnabled) this.append(config.enabled ? 'switched on' : 'switched off');
    this.save();
    return this.stateView();
  }

  clearLog(): CheckScheduleState {
    this.state.log = [];
    this.save();
    return this.stateView();
  }

  /* ---------------------------------------------------------------- */
  /* The schedule                                                       */
  /* ---------------------------------------------------------------- */

  /** Checks every `tickMs` whether a sweep is due, so a config change applies. */
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

  /** One turn of the schedule: advance what is running, or start what is due. */
  async tickNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    try {
      // A sweep that is already in line is advanced first: two sweeps must never
      // overlap, because the second would just re-queue the first's titles and
      // double the reads.
      if (this.pending) {
        this.advance();
        return;
      }
      if (!this.state.config.enabled) return;
      if (!this.deps.archive.configured) return;
      const dueAt = this.state.lastRunAt ? Date.parse(this.state.lastRunAt) + this.state.config.intervalMs : 0;
      if (this.now() < dueAt) return;
      this.begin();
    } catch (error) {
      this.append(`sweep failed: ${describeError(error)}`);
    }
  }

  /** Runs a sweep now, whatever the schedule says. */
  runNow(): CheckScheduleState {
    if (!this.deps.archive.configured) return this.stateView();
    try {
      if (this.pending) this.advance();
      else this.begin();
    } catch (error) {
      this.append(`sweep failed: ${describeError(error)}`);
    }
    return this.stateView();
  }

  /**
   * Opens a sweep: the work list is the archive's own list of checkable titles,
   * and the first wave of it goes into the queue now.
   *
   * Nothing waits on gigabytes — the titles go in line and this returns.
   */
  private begin(): void {
    const candidates = this.deps.archive.verifyCandidates();
    const startedAt = this.nowIso();
    if (!candidates.length) {
      this.finish({ startedAt, finishedAt: startedAt, queued: 0, skipped: 0, passing: 0, failing: 0, unfinished: 0, failingKeys: [], note: 'nothing was in R2 to check' });
      return;
    }
    this.pending = { startedAt, queue: candidates.map((candidate) => candidate.key), started: [], skipped: 0 };
    this.append(`checking ${candidates.length} title(s)${candidates.length > this.state.config.batchSize ? ` ${this.state.config.batchSize} at a time` : ''}`);
    this.advance();
  }

  /**
   * Feeds the next wave and closes the sweep once there is nothing left.
   *
   * One wave at a time is deliberate: the queue never holds more than a batch,
   * and a wave is only offered once the previous one has been worked through, so
   * the reads are paced by the work itself rather than by how big the library is.
   */
  private advance(): void {
    const pending = this.pending;
    if (!pending) return;

    if (pending.queue.length && this.deps.archive.busy === 0) {
      const wave = pending.queue.splice(0, this.state.config.batchSize);
      const report = this.deps.archive.enqueueKeys(wave, wave.length, 'verify');
      for (const task of report.queued) pending.started.push(task.key);
      // Every title that could not be queued this wave (already being checked,
      // or no longer checkable) is counted, not quietly dropped.
      pending.skipped += report.skipped.length;
    }

    if (pending.queue.length || this.deps.archive.busy > 0) {
      // A wedged queue must not leave the schedule open forever.
      if (this.now() - Date.parse(pending.startedAt) < MAX_SWEEP_MS) return;
      this.finish({
        startedAt: pending.startedAt,
        finishedAt: this.nowIso(),
        queued: pending.started.length,
        skipped: pending.skipped,
        passing: 0,
        failing: 0,
        unfinished: pending.started.length,
        failingKeys: [],
        pendingKeys: pending.queue.slice(0, 50),
        note: `gave up after ${Math.round(MAX_SWEEP_MS / 3_600_000)} h with ${pending.queue.length} title(s) still to queue`,
      });
      return;
    }

    // The verdicts are read back from the catalogue rather than from the tasks:
    // a record is what survives, and it is what a person reads months later.
    const failingKeys: string[] = [];
    let passing = 0;
    for (const key of pending.started) {
      const verify = this.deps.catalog.get(key)?.archive?.verify;
      if (!verify) continue;
      if (verify.ok) passing += 1;
      else failingKeys.push(key);
    }
    const checked = passing + failingKeys.length;
    const named = failingKeys.length ? ` — ${failingKeys.slice(0, 3).join(', ')}${failingKeys.length > 3 ? ` and ${failingKeys.length - 3} more` : ''}` : '';
    const note =
      checked === 0
        ? `checked nothing of ${pending.started.length} title(s)`
        : `checked ${checked} title(s): ${passing} still match, ${failingKeys.length} stopped matching${named}`;
    this.finish({
      startedAt: pending.startedAt,
      finishedAt: this.nowIso(),
      queued: pending.started.length,
      skipped: pending.skipped,
      passing,
      failing: failingKeys.length,
      unfinished: pending.started.length - checked,
      failingKeys,
      note,
    });
  }

  private finish(report: CheckSweepReport): void {
    this.pending = undefined;
    this.state.lastSweep = report;
    // Stamped with when the sweep *started*: the cadence is "every week", not
    // "a week after the last one finished reading a library".
    this.state.lastRunAt = report.startedAt;
    this.append(report.note);
    this.save();
  }
}

/**
 * A stored (or configured) interval is clamped into the range the schedule
 * accepts, so `R2_VERIFY_INTERVAL_MS=1` cannot turn a weekly pass into a
 * continuous read of the whole bucket.
 */
export function clampCheckInterval(value: unknown, fallback = CHECK_DEFAULT_INTERVAL_MS): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(CHECK_MIN_INTERVAL_MS, Math.min(CHECK_MAX_INTERVAL_MS, Math.floor(n)));
}

function clampBatch(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(CHECK_MAX_BATCH, Math.floor(n)));
}
