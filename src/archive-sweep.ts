/**
 * The automatic routing to R2, as a state the dashboard converges to.
 *
 * A title is queued for the archive the moment it finishes publishing — but that
 * is a single event, and any one of four ordinary things stops it from being the
 * last word:
 *
 *   - the dashboard restarts while a copy is in flight (the queue is memory);
 *   - R2 is unreachable for longer than the retry budget (3 tries, ~5 min apart);
 *   - the copy lands and Bunny refuses the delete, which is recorded and then
 *     never tried again;
 *   - archiving was switched off, or had no destination, when the title
 *     published — and switching it on later does not look back.
 *
 * In all four the title sits in Bunny with a `ready` job, a catalogue entry and
 * nothing at all that will ever pick it up, which is the difference between an
 * automatic archive and a *fully* automatic one. This is the missing half: on a
 * timer it re-reads the catalogue and does exactly what the Archive button does —
 * queues what is still missing, oldest publication first, and retries the deletes
 * Bunny refused — so a title ends up in R2 and out of Bunny without anybody
 * pressing anything, however the first attempt went.
 *
 * Everything it queues goes through the archive's own queue and its own switch:
 * a sweep never reads a bucket or touches Bunny itself, it only puts work in
 * line, and while `archive.enabled()` is false it does nothing at all. Nothing is
 * persisted either — the catalogue *is* the work list, so a sweep after a restart
 * just recomputes it.
 */
import type { ArchiveCandidate, ArchiveEnqueueReport, ArchiveRemovalReport } from './archive';
import type { R2ArchiveConfig } from './config';
import { clampSweepInterval } from './config';

/** The narrow slice of the archive service a sweep needs. */
export interface SweepArchive {
  readonly configured: boolean;
  /** The operator's switch and a configured destination, together. */
  enabled(): boolean;
  /** Titles with no completed copy yet — the work list. */
  preview(): { candidates: ArchiveCandidate[] };
  /** Puts titles in line; the same call the Archive button makes. */
  enqueueKeys(keys: string[], limit: number, operation: 'archive'): ArchiveEnqueueReport;
  /** Retries the Bunny deletes that did not happen after a complete copy. */
  removeLeftovers(limit: number): Promise<ArchiveRemovalReport>;
  /** Queued plus in-flight tasks. */
  readonly busy: number;
}

export interface ArchiveSweepDeps {
  /** The archive settings, or nothing when no destination is configured. */
  config?: Pick<R2ArchiveConfig, 'sweep' | 'sweepIntervalMs' | 'sweepBatch'>;
  archive: SweepArchive;
  log?: (message: string) => void;
  now?: () => number;
}

/** What one sweep did. Kept in memory: it describes a moment, not a setting. */
export interface ArchiveSweepReport {
  startedAt: string;
  /** Titles this sweep put in line. */
  queued: number;
  /** Titles it tried again to take out of Bunny. */
  removed: number;
  /** Titles Bunny refused again, with the reasons. */
  refused: Array<{ key: string; error: string }>;
  /** Titles still waiting for a copy after this sweep's batch. */
  remaining: number;
  /** Set when the sweep stood aside, e.g. the switch went off mid-run. */
  note?: string;
}

export interface ArchiveSweepState {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  running: boolean;
  lastRunAt?: string;
  lastReport?: ArchiveSweepReport;
}

/**
 * How often the sweep asks whether it is due, rather than sleeping for the whole
 * interval: a changed `R2_SWEEP_INTERVAL_MS` (or a switch flipped in Settings)
 * then applies to the next tick instead of to the next process.
 */
const SWEEP_TICK_MS = 15_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ArchiveSweep {
  private deps: ArchiveSweepDeps;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRunAt: number | undefined;
  private lastReport: ArchiveSweepReport | undefined;
  private logLine: (message: string) => void;
  private now: () => number;

  constructor(deps: ArchiveSweepDeps) {
    this.deps = deps;
    this.logLine = deps.log ?? ((message) => console.log(message));
    this.now = deps.now ?? (() => Date.now());
  }

  private get settings(): Pick<R2ArchiveConfig, 'sweep' | 'sweepIntervalMs' | 'sweepBatch'> | undefined {
    return this.deps.config;
  }

  /** Whether a sweep would do anything right now. */
  get enabled(): boolean {
    const config = this.settings;
    if (!config?.sweep) return false;
    return this.deps.archive.configured && this.deps.archive.enabled();
  }

  /**
   * Checks whether a sweep is due, on a short timer of its own.
   *
   * The body is guarded like every other background loop: a sweep that throws
   * must cost one tick, never the process. The first tick is a few seconds after
   * startup, which is deliberate — a sweep straight away would race the job
   * recovery that is also finishing interrupted work.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const config = this.settings;
    if (!config?.sweep) return;
    if (this.running) return;
    const dueAt = (this.lastRunAt ?? 0) + clampSweepInterval(config.sweepIntervalMs);
    if (this.now() < dueAt) return;
    await this.sweepNow();
  }

  /**
   * One pass: queue what is missing, and take out what did not leave.
   *
   * Answers the report so the caller — a test, or the API behind a button — can
   * see what happened; the work itself runs on the archive's queue.
   */
  async sweepNow(): Promise<ArchiveSweepReport> {
    const startedAt = new Date(this.now()).toISOString();
    const report: ArchiveSweepReport = { startedAt, queued: 0, removed: 0, refused: [], remaining: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const batch = Math.max(1, Math.floor(this.settings?.sweepBatch ?? 25));
      if (this.deps.archive.configured && this.deps.archive.enabled()) {
        // No keys: the queue picks the candidates itself, which is the same
        // work list the Library's Archive button walks.
        const enqueued = this.deps.archive.enqueueKeys([], batch, 'archive');
        report.queued = enqueued.queued.length;
        if (report.queued) {
          this.logLine(
            `[archive] automatic sweep: ${report.queued} title(s) queued for R2${enqueued.skipped.length ? `, ${enqueued.skipped.length} skipped` : ''}`,
          );
        }
      } else {
        report.note = this.deps.archive.configured ? 'archiving is switched off' : 'no R2 destination is configured';
      }

      // A copy whose delete Bunny refused is already safe in the bucket: finishing
      // the removal is the other half of routing it out of Bunny.
      if (this.deps.archive.configured) {
        const removal = await this.deps.archive.removeLeftovers(batch);
        report.removed = removal.removed.length;
        report.refused = removal.failed;
        for (const key of removal.removed) this.logLine(`[archive] automatic sweep: ${key} is out of Bunny now`);
      }

      report.remaining = this.deps.archive.preview().candidates.length;
    } catch (error) {
      // One bad sweep must not stop the next one, and must not escape: this runs
      // from a timer, where a throw would be an uncaught exception.
      report.note = `the sweep failed: ${describeError(error)}`;
      this.logLine(`[archive] the automatic sweep failed: ${describeError(error)}`);
    } finally {
      this.running = false;
      this.lastRunAt = this.now();
      this.lastReport = report;
    }
    return report;
  }

  /** What the panel shows: the interval in force, and what the last pass did. */
  stateView(): ArchiveSweepState {
    const config = this.settings;
    return {
      enabled: config?.sweep ?? false,
      intervalMs: clampSweepInterval(config?.sweepIntervalMs),
      batchSize: Math.max(1, Math.floor(config?.sweepBatch ?? 25)),
      running: this.running,
      ...(this.lastRunAt !== undefined ? { lastRunAt: new Date(this.lastRunAt).toISOString() } : {}),
      ...(this.lastReport ? { lastReport: this.lastReport } : {}),
    };
  }
}
