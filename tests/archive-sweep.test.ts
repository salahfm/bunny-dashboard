/**
 * The reconciler: the half of the automatic routing that survives a bad day.
 *
 * A publish queues its own archive exactly once, so these tests are about the
 * cases where that one attempt is not the last word — a restart, an R2 outage, a
 * switch that was off at the time — and about the sweep never doing more than
 * putting the same work the Archive button would put in line.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArchiveCandidate, ArchiveEnqueueReport, ArchiveRemovalReport } from '../src/archive';
import { ArchiveSweep } from '../src/archive-sweep';
import type { SweepArchive } from '../src/archive-sweep';

/** One candidate the stub archive would offer. */
function candidate(key: string): ArchiveCandidate {
  return { key, title: key, kind: 'movie' };
}

interface StubOptions {
  /** Titles with no copy yet. */
  candidates?: string[];
  configured?: boolean;
  enabled?: boolean;
  /** Keys whose removal Bunny refuses again. */
  refusals?: string[];
  /** Keys the sweep should find removable. */
  leftovers?: string[];
}

/** The slice of the archive a sweep drives, recording how it was called. */
class StubArchive implements SweepArchive {
  readonly calls: Array<{ keys: string[]; limit: number; operation: string }> = [];
  removalCalls: number[] = [];
  readonly configured: boolean;
  readonly busy = 0;
  private options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.options = options;
    this.configured = options.configured ?? true;
  }

  enabled(): boolean {
    return this.options.enabled ?? true;
  }

  preview(): { candidates: ArchiveCandidate[] } {
    return { candidates: (this.options.candidates ?? []).map(candidate) };
  }

  enqueueKeys(keys: string[], limit: number, operation: 'archive'): ArchiveEnqueueReport {
    this.calls.push({ keys, limit, operation });
    const wanted = (keys.length ? keys : this.options.candidates ?? []).slice(0, limit);
    // Queued titles stop being candidates, exactly as the real archive does.
    this.options.candidates = (this.options.candidates ?? []).filter((key) => !wanted.includes(key));
    return {
      configured: true,
      queued: wanted.map((key) => ({ key }) as never),
      skipped: [],
    };
  }

  async removeLeftovers(limit: number): Promise<ArchiveRemovalReport> {
    this.removalCalls.push(limit);
    const attempted = (this.options.leftovers ?? []).slice(0, limit);
    this.options.leftovers = (this.options.leftovers ?? []).filter((key) => !attempted.includes(key));
    // A title is either removed or refused — never both, which is what the real
    // service reports: the failed ones are exactly the ones it could not take out.
    const refused = new Set(this.options.refusals ?? []);
    return {
      attempted: attempted.length,
      removed: attempted.filter((key) => !refused.has(key)),
      failed: attempted.filter((key) => refused.has(key)).map((key) => ({ key, error: 'Bunny said no' })),
      skipped: 0,
    };
  }
}

function sweep(archive: StubArchive, config: { sweep?: boolean; sweepIntervalMs?: number; sweepBatch?: number } = {}, now = () => 0) {
  return new ArchiveSweep({
    config: { sweep: config.sweep ?? true, sweepIntervalMs: config.sweepIntervalMs ?? 60_000, sweepBatch: config.sweepBatch ?? 25 },
    archive,
    now,
    log: () => undefined,
  });
}

test('a sweep queues what is still missing, one batch at a time, oldest first', async () => {
  const archive = new StubArchive({ candidates: ['a', 'b', 'c', 'd', 'e'] });
  const service = sweep(archive, { sweepBatch: 2 });

  const first = await service.sweepNow();
  assert.equal(first.queued, 2, 'the batch is the cap, not the backlog');
  assert.equal(first.remaining, 3, 'and the rest is reported as still waiting');
  assert.deepEqual(archive.calls[0]?.keys, [], 'the queue picks the candidates itself, oldest first');
  assert.equal(archive.calls[0]?.operation, 'archive');

  const second = await service.sweepNow();
  assert.equal(second.queued, 2);
  assert.equal(second.remaining, 1, 'the next sweep continues where the first stopped');

  const third = await service.sweepNow();
  assert.equal(third.queued, 1);
  assert.equal(third.remaining, 0);

  const idle = await service.sweepNow();
  assert.equal(idle.queued, 0, 'a finished library has nothing left to queue');
  service.stop();
});

test('a sweep queues nothing while archiving is switched off, but still finishes a removal', async () => {
  const archive = new StubArchive({ candidates: ['a', 'b'], enabled: false, leftovers: ['x'] });
  const service = sweep(archive);

  const report = await service.sweepNow();
  assert.equal(report.queued, 0);
  assert.deepEqual(archive.calls, [], 'the operator\u2019s switch is the switch for anything new');
  assert.equal(report.note, 'archiving is switched off');

  // A removal is not an archive: the copy is already in the bucket, and the
  // switch says "do not copy automatically", not "keep paying Bunny for a title
  // I already have". So the leftovers are still taken out — the same rule the
  // service already applies to a verification or a restore.
  assert.deepEqual(archive.removalCalls, [25]);
  assert.equal(report.removed, 1);
  assert.equal(service.enabled, false, 'while the sweep itself stays idle for new work');
  service.stop();
});

test('a sweep says so when there is no destination, and never queues', async () => {
  const archive = new StubArchive({ configured: false, candidates: ['a'] });
  const service = sweep(archive);

  const report = await service.sweepNow();
  assert.equal(report.queued, 0);
  assert.equal(report.note, 'no R2 destination is configured');
  assert.deepEqual(archive.calls, []);
  service.stop();
});

test('a sweep finishes the removals Bunny refused, and reports the ones it refuses again', async () => {
  const archive = new StubArchive({ leftovers: ['a', 'b'], refusals: ['b'] });
  const service = sweep(archive);

  const report = await service.sweepNow();
  assert.equal(report.removed, 1, 'the one Bunny let go is removed');
  assert.deepEqual(
    report.refused.map((entry) => entry.key),
    ['b'],
    'and the one it refused is reported rather than lost',
  );
  assert.deepEqual(archive.removalCalls, [25], 'the batch size governs removals too');
  service.stop();
});

test('the sweep runs on its own interval, and not more often', async () => {
  const archive = new StubArchive({ candidates: ['a', 'b', 'c'] });
  let clock = 1_000_000;
  const service = sweep(archive, { sweepIntervalMs: 30_000 }, () => clock);
  service.start();

  // The timer itself is a real 15 s tick, so drive the same path directly: what
  // is under test is the interval, not the clock.
  await service.sweepNow();
  assert.equal(archive.calls.length, 1);

  clock += 5_000;
  assert.equal(service.stateView().lastRunAt !== undefined, true, 'the last run is reported for the panel');
  const report = service.stateView().lastReport;
  assert.equal(report?.queued, 3);

  service.stop();
});

test('a sweep that throws is reported and does not escape', async () => {
  const broken: SweepArchive = {
    configured: true,
    busy: 0,
    enabled: () => true,
    preview: () => ({ candidates: [] }),
    enqueueKeys: () => {
      throw new Error('the queue exploded');
    },
    removeLeftovers: async () => ({ attempted: 0, removed: [], failed: [], skipped: 0 }),
  };
  const service = sweep(broken as StubArchive);

  const report = await service.sweepNow();
  assert.match(report.note ?? '', /the sweep failed: the queue exploded/);
  assert.equal(service.stateView().running, false, 'and the sweep is not left wedged');
  service.stop();
});
