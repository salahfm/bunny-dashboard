/**
 * The scheduled verification pass, driven without a bucket or a clock.
 *
 * The schedule's whole job is a handful of decisions: is a sweep due, what goes
 * in line, has the queue gone quiet, and what did the records say when it had.
 * So these tests stand in for the archive with a queue they can work by hand —
 * which is also the only way to watch a sweep *mid-flight*, something a real
 * several-gigabyte check would never let a test see.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArchiveCheckSchedule,
  CHECK_DEFAULT_BATCH,
  CHECK_DEFAULT_INTERVAL_MS,
  CHECK_MAX_INTERVAL_MS,
  CheckScheduleError,
  clampCheckInterval,
  type CheckScheduleArchive,
} from '../src/check-schedule';
import type { ArchiveEnqueueReport, ArchiveTask } from '../src/archive';
import { Catalog } from '../src/catalog';
import type { AppConfig } from '../src/config';
import { testConfig } from './helpers';
import { newJob, type Account, type JobTarget } from '../src/store';

const NOW = new Date('2025-06-01T12:00:00Z');

const ACCOUNT: Account = {
  id: 'acc-1',
  name: 'primary',
  libraryId: '123456',
  apiKeyEnc: 'enc',
  pullZoneHost: 'cdn.example.b-cdn.net',
  enabled: true,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function movieTarget(tmdbId: number, title: string): JobTarget {
  return { kind: 'movie', tmdbId, title, year: '2010' };
}

/**
 * A stand-in for the archive's queue.
 *
 * `enqueueKeys` only notes the work, exactly as the real one does — the browser
 * would watch the rest arrive over the event stream. `work()` is the test's own
 * hand on the queue: it writes a verdict for everything waiting, drains it, and
 * reports the queue quiet again.
 */
class StubArchive implements CheckScheduleArchive {
  configured = true;
  /** Queued or moving right now. */
  busy = 0;
  /** Every enqueue this schedule asked for, in order. */
  calls: Array<{ keys: string[]; limit: number; operation: string }> = [];
  /** The keys actually waiting in the queue, which is what `work()` settles. */
  waiting: string[] = [];
  /** Keys the archive refuses because it is already working on them. */
  held = new Set<string>();
  /** What a finished title's check says. Default: everything still matches. */
  verdicts = new Map<string, boolean>();
  /** The time written into each verdict. */
  verdictAt = NOW.toISOString();

  constructor(private candidates: string[]) {}

  verifyCandidates(): Array<{ key: string; title: string; kind: 'movie' }> {
    return this.candidates.map((key) => ({ key, title: key, kind: 'movie' as const }));
  }

  enqueueKeys(keys: string[], limit: number, operation: 'verify'): ArchiveEnqueueReport {
    const wanted = keys.slice(0, limit);
    this.calls.push({ keys: [...wanted], limit, operation });
    const queued: ArchiveTask[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const key of wanted) {
      if (this.held.has(key)) {
        skipped.push({ key, reason: 'already checking this title' });
        continue;
      }
      queued.push({ key, title: key, kind: 'movie', operation, status: 'queued' } as ArchiveTask);
      this.waiting.push(key);
    }
    this.busy += queued.length;
    return { configured: true, queued, skipped };
  }

  /** Works the queue: every waiting title gets its verdict and is drained. */
  work(catalog: Catalog): void {
    for (const key of this.waiting) {
      const ok = this.verdicts.get(key) ?? true;
      catalog.setArchiveVerify(key, { at: this.verdictAt, ok, checked: 3, missing: [], mismatched: ok ? [] : ['video/720p.mp4'] });
    }
    this.calls = [];
    this.waiting = [];
    this.busy = 0;
  }
}

interface Rig {
  dir: string;
  config: AppConfig;
  catalog: Catalog;
  archive: StubArchive;
  schedule: ArchiveCheckSchedule;
  /** Move the schedule's clock. */
  setNow: (ms: number) => void;
  /** Build a new schedule over the same data directory. */
  reopen: () => ArchiveCheckSchedule;
}

/** One archived title in the catalogue, ready to be re-checked. */
function archiveTitle(catalog: Catalog, tmdbId: number, title: string): string {
  const job = Object.assign(newJob(movieTarget(tmdbId, title), { kind: 'stream', mode: 'scrape', name: `${title}.mkv` }), {
    status: 'ready',
    accountId: ACCOUNT.id,
    bunnyVideoId: 'vid-abc',
    playbackUrl: 'https://cdn.example.b-cdn.net/vid-abc/playlist.m3u8',
    statusCode: 4,
  });
  const entry = catalog.record(job, ACCOUNT);
  const folder = `archive/Movies/${title} [${tmdbId}]`;
  catalog.setArchive(entry.key, {
    bucket: 'archive',
    prefix: folder,
    objects: [
      { name: 'video/720p.mp4', key: `${folder}/video/720p.mp4`, kind: 'video', bytes: 2_048, sha256: 'aa', contentType: 'video/mp4' },
      { name: 'manifest.json', key: `${folder}/manifest.json`, kind: 'manifest', bytes: 128, sha256: 'bb', contentType: 'application/json' },
    ],
    manifestKey: `${folder}/manifest.json`,
    bytes: 2_176,
    videoBytes: 2_048,
    videos: 1,
    complete: true,
    videoId: 'vid-abc',
    removedFromBunny: true,
    verifiedAt: '2025-01-01T00:00:00.000Z',
    at: '2025-01-01T00:00:00.000Z',
  });
  return entry.key;
}

function rig(options: { titles?: Array<[number, string]>; configVerify?: boolean; configIntervalMs?: number } = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-check-'));
  const config = testConfig(dir, {
    ...(options.configVerify === undefined && options.configIntervalMs === undefined
      ? {}
      : {
          r2: {
            accountId: 'acct',
            accessKeyId: 'key',
            secretAccessKey: 'secret',
            bucket: 'archive',
            prefix: 'archive',
            enabled: true,
            keepBunny: false,
            urlTtl: 300,
            verify: options.configVerify ?? true,
            verifyIntervalMs: options.configIntervalMs ?? CHECK_DEFAULT_INTERVAL_MS,
          },
        }),
  });
  const catalog = new Catalog(config);
  const titles = options.titles ?? [
    [27205, 'Inception'],
    [550, 'Fight Club'],
    [13, 'Forrest Gump'],
  ];
  const keys = titles.map(([tmdbId, title]) => archiveTitle(catalog, tmdbId, title));
  const archive = new StubArchive(keys);
  let clock = NOW.getTime();
  const build = (): ArchiveCheckSchedule =>
    new ArchiveCheckSchedule({
      config,
      catalog,
      archive,
      now: () => clock,
      log: () => {},
    });
  const schedule = build();
  return {
    dir,
    config,
    catalog,
    archive,
    schedule,
    setNow: (ms) => {
      clock = ms;
    },
    reopen: build,
  };
}

function cleanUp(r: Rig): void {
  fs.rmSync(r.dir, { recursive: true, force: true });
}

test('a weekly sweep checks every archived title and refreshes its verifiedAt', async () => {
  const r = rig();
  try {
    await r.schedule.tickNow();

    // Everything in R2 went into the queue, in one wave.
    assert.equal(r.archive.calls.length, 1);
    assert.deepEqual(r.archive.calls[0]?.keys.sort(), r.catalog.all().map((entry) => entry.key).sort());
    assert.equal(r.archive.calls[0]?.operation, 'verify');
    assert.equal(r.schedule.stateView().running, true);
    assert.equal(r.schedule.stateView().lastSweep, null, 'the sweep is not finished while the queue is working');
    // No verdict has been written yet, so there is nothing to count.
    assert.deepEqual(r.schedule.totals(), { archived: 3, checked: 0, failing: 0, never: 3 });

    r.archive.work(r.catalog);
    await r.schedule.tickNow();

    const state = r.schedule.stateView();
    assert.equal(state.running, false);
    assert.equal(state.lastSweep?.queued, 3);
    assert.equal(state.lastSweep?.passing, 3);
    assert.equal(state.lastSweep?.failing, 0);
    assert.deepEqual(state.lastSweep?.failingKeys, []);
    assert.match(state.lastSweep?.note ?? '', /checked 3 title\(s\): 3 still match, 0 stopped matching/);
    assert.equal(state.lastRunAt, NOW.toISOString());
    assert.deepEqual(state.totals, { archived: 3, checked: 3, failing: 0, never: 0 });
    // `verifiedAt` moved on every record — the point of the pass.
    for (const entry of r.catalog.all()) assert.equal(entry.archive?.verifiedAt, NOW.toISOString());
  } finally {
    cleanUp(r);
  }
});

test('a sweep names the titles that stopped matching', async () => {
  const r = rig();
  try {
    const keys = r.catalog.all().map((entry) => entry.key);
    const broken = keys[1] as string;
    r.archive.verdicts.set(broken, false);

    await r.schedule.tickNow();
    r.archive.work(r.catalog);
    await r.schedule.tickNow();

    const state = r.schedule.stateView();
    assert.equal(state.lastSweep?.passing, 2);
    assert.equal(state.lastSweep?.failing, 1);
    assert.deepEqual(state.lastSweep?.failingKeys, [broken]);
    assert.match(state.lastSweep?.note ?? '', /2 still match, 1 stopped matching/);
    assert.deepEqual(state.totals, { archived: 3, checked: 3, failing: 1, never: 0 });
  } finally {
    cleanUp(r);
  }
});

test('the environment supplies the defaults, and a choice made in the dashboard wins from then on', () => {
  const r = rig({ configVerify: false, configIntervalMs: 2 * 24 * 60 * 60_000 });
  try {
    // A configured `R2_VERIFY=off` is honoured: nothing is queued even though a
    // title is sitting there to check.
    assert.equal(r.schedule.stateView().config.enabled, false);
    assert.equal(r.schedule.stateView().config.intervalMs, 2 * 24 * 60 * 60_000);
    assert.equal(r.schedule.stateView().nextRunAt, null);

    r.schedule.updateConfig({ enabled: true, intervalMs: 60 * 60_000 });

    // Reopening reads the stored choice, not the environment's.
    const reopened = r.reopen();
    assert.equal(reopened.stateView().config.enabled, true);
    assert.equal(reopened.stateView().config.intervalMs, 60 * 60_000);
  } finally {
    cleanUp(r);
  }
});

test('a sweep runs once the interval has passed, and not a moment before', async () => {
  const r = rig();
  try {
    await r.schedule.tickNow();
    r.archive.work(r.catalog);
    await r.schedule.tickNow();
    assert.equal(r.archive.calls.length, 0, 'the queue is quiet again');

    // A day short of a week: nothing is due, and the next run is named.
    r.setNow(NOW.getTime() + CHECK_DEFAULT_INTERVAL_MS - 24 * 60 * 60_000);
    await r.schedule.tickNow();
    assert.equal(r.archive.calls.length, 0);
    assert.equal(r.schedule.stateView().nextRunAt, new Date(NOW.getTime() + CHECK_DEFAULT_INTERVAL_MS).toISOString());

    // Past due: the sweep starts on the next tick.
    r.setNow(NOW.getTime() + CHECK_DEFAULT_INTERVAL_MS + 1);
    await r.schedule.tickNow();
    assert.equal(r.archive.calls.length, 1);
    assert.equal(r.schedule.stateView().running, true);
  } finally {
    cleanUp(r);
  }
});

test('a library bigger than one batch is walked in waves, one settled wave at a time', async () => {
  const r = rig({
    titles: [
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
      [4, 'Four'],
      [5, 'Five'],
    ],
  });
  try {
    r.schedule.updateConfig({ batchSize: 2 });
    await r.schedule.tickNow();
    assert.deepEqual(r.archive.calls.map((call) => call.keys.length), [2]);

    // While the first wave is moving, no second wave is offered: the queue is
    // never deeper than the batch.
    await r.schedule.tickNow();
    assert.deepEqual(r.archive.calls.map((call) => call.keys.length), [2]);

    // A settled wave hands the next one over.
    r.archive.work(r.catalog);
    await r.schedule.tickNow();
    assert.deepEqual(r.archive.calls.map((call) => call.keys.length), [2]);
    r.archive.work(r.catalog);
    await r.schedule.tickNow();
    assert.deepEqual(r.archive.calls.map((call) => call.keys.length), [1]);

    r.archive.work(r.catalog);
    await r.schedule.tickNow();

    assert.deepEqual(r.archive.calls, [], 'the queue is quiet');
    const state = r.schedule.stateView();
    assert.equal(state.running, false);
    assert.equal(state.lastSweep?.queued, 5, 'all five were put in line across the waves');
    assert.equal(state.lastSweep?.passing, 5);
    assert.equal(state.totals.checked, 5);
  } finally {
    cleanUp(r);
  }
});

test('a sweep is not started when there is no archive to check', async () => {
  const r = rig();
  try {
    r.archive.configured = false;
    await r.schedule.tickNow();
    assert.equal(r.archive.calls.length, 0);
    assert.equal(r.schedule.stateView().nextRunAt, null);
    // Even by hand there is nothing to do.
    const state = r.schedule.runNow();
    assert.equal(state.running, false);
    assert.equal(r.archive.calls.length, 0);
  } finally {
    cleanUp(r);
  }
});

test('an empty archive is closed out at once rather than re-checked every tick', async () => {
  const r = rig({ titles: [] });
  try {
    await r.schedule.tickNow();
    const state = r.schedule.stateView();
    assert.equal(state.running, false);
    assert.equal(state.lastRunAt, NOW.toISOString());
    assert.equal(state.lastSweep?.note, 'nothing was in R2 to check');
    assert.equal(state.lastSweep?.queued, 0);
    assert.equal(r.archive.calls.length, 0);
  } finally {
    cleanUp(r);
  }
});

test('a sweep that never gets its queue back gives up and says so', async () => {
  const r = rig();
  try {
    await r.schedule.tickNow();
    assert.equal(r.schedule.stateView().running, true);

    // The queue stalls — a wedged transfer would look exactly like this — and a
    // day later the sweep stops waiting rather than staying open forever.
    r.setNow(NOW.getTime() + 25 * 60 * 60_000);
    await r.schedule.tickNow();

    const state = r.schedule.stateView();
    assert.equal(state.running, false);
    assert.equal(state.lastSweep?.unfinished, 3);
    assert.match(state.lastSweep?.note ?? '', /gave up after 24 h/);
    // Nothing was checked, so nothing is counted as passing or failing.
    assert.equal(state.lastSweep?.passing, 0);
    assert.equal(state.lastSweep?.failing, 0);
    assert.equal(state.totals.never, 3);
  } finally {
    cleanUp(r);
  }
});

test('a title that was already being checked is skipped, not double-queued', async () => {
  const r = rig();
  try {
    const keys = r.catalog.all().map((entry) => entry.key);
    r.archive.held.add(keys[2] as string);

    await r.schedule.tickNow();
    r.archive.work(r.catalog);
    await r.schedule.tickNow();

    const state = r.schedule.stateView();
    assert.equal(state.lastSweep?.queued, 2);
    assert.equal(state.lastSweep?.skipped, 1);
    assert.equal(state.totals.never, 1, 'the held title has no verdict of its own yet');
  } finally {
    cleanUp(r);
  }
});

test('runNow sweeps whatever the schedule says, and only one sweep runs at a time', async () => {
  const r = rig();
  try {
    r.schedule.updateConfig({ enabled: false });

    const state = r.schedule.runNow();
    assert.equal(state.running, true);
    assert.equal(r.archive.calls.length, 1);

    // Pressing it again while the first is in line does not queue a second
    // pass over the same titles.
    const again = r.schedule.runNow();
    assert.equal(again.running, true);
    assert.equal(r.archive.calls.length, 1);

    r.archive.work(r.catalog);
    await r.schedule.tickNow();
    assert.equal(r.schedule.stateView().running, false);
  } finally {
    cleanUp(r);
  }
});

test('a nonsense setting is refused rather than stored', () => {
  const r = rig();
  try {
    assert.throws(() => r.schedule.updateConfig({ enabled: 'yes' }), CheckScheduleError);
    assert.throws(() => r.schedule.updateConfig({ intervalMs: 60_000 }), /between 1 hour and 30 days/);
    assert.throws(() => r.schedule.updateConfig({ intervalMs: CHECK_MAX_INTERVAL_MS + 1 }), CheckScheduleError);
    assert.throws(() => r.schedule.updateConfig({ batchSize: 0 }), /titles per pass/);
    assert.throws(() => r.schedule.updateConfig({ batchSize: 5_001 }), CheckScheduleError);
    // Nothing above changed the schedule's own defaults.
    assert.equal(r.schedule.stateView().config.intervalMs, CHECK_DEFAULT_INTERVAL_MS);
    assert.equal(r.schedule.stateView().config.batchSize, CHECK_DEFAULT_BATCH);
  } finally {
    cleanUp(r);
  }
});

test('the log records the switch and what each sweep found, and can be cleared', async () => {
  const r = rig();
  try {
    r.schedule.updateConfig({ enabled: false });
    r.schedule.updateConfig({ enabled: true });
    await r.schedule.tickNow();
    r.archive.work(r.catalog);
    await r.schedule.tickNow();

    const log = r.schedule.stateView().log;
    assert.match(log[0] ?? '', /checked 3 title\(s\)/);
    assert.match(log.find((line) => /switched on/.test(line)) ?? '', /switched on/);
    // Newest first, which is the order Settings reads them in.
    assert.ok(new Date(log[0]?.slice(0, 24) ?? 0) >= new Date(log[log.length - 1]?.slice(0, 24) ?? 0));

    const cleared = r.schedule.clearLog();
    assert.deepEqual(cleared.log, []);
    assert.equal(r.schedule.stateView().log.length, 0, 'and it stays cleared');
  } finally {
    cleanUp(r);
  }
});

test('the schedule survives a restart with its sweep history intact', async () => {
  const r = rig();
  try {
    await r.schedule.tickNow();
    r.archive.work(r.catalog);
    await r.schedule.tickNow();
    const before = r.schedule.stateView();

    const reopened = r.reopen();
    const after = reopened.stateView();
    assert.equal(after.lastRunAt, before.lastRunAt);
    assert.deepEqual(after.lastSweep, before.lastSweep);
    assert.equal(after.totals.checked, 3);
    assert.equal(after.running, false);
  } finally {
    cleanUp(r);
  }
});

test('a corrupt schedule file is set aside, not fatal', () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'archive-check.json'), '{ not json');
    const reopened = r.reopen();
    assert.equal(reopened.stateView().config.enabled, true, 'the defaults come back');
    assert.ok(fs.readdirSync(r.dir).some((name) => name.startsWith('archive-check.json.corrupt-')), 'the bad file was kept');
  } finally {
    cleanUp(r);
  }
});

test('a stored interval outside the accepted range is clamped on load', () => {
  const r = rig();
  try {
    fs.writeFileSync(
      path.join(r.dir, 'archive-check.json'),
      JSON.stringify({ version: 1, config: { enabled: true, intervalMs: 1, batchSize: 999_999 }, lastRunAt: null, lastSweep: null, log: [] }),
    );
    const reopened = r.reopen();
    assert.equal(reopened.stateView().config.intervalMs, 60 * 60_000);
    assert.equal(reopened.stateView().config.batchSize, 5_000);
  } finally {
    cleanUp(r);
  }
});

test('clampCheckInterval keeps a configured interval inside the accepted range', () => {
  assert.equal(clampCheckInterval(undefined), CHECK_DEFAULT_INTERVAL_MS);
  assert.equal(clampCheckInterval('nonsense'), CHECK_DEFAULT_INTERVAL_MS);
  assert.equal(clampCheckInterval(2 * 24 * 60 * 60_000), 2 * 24 * 60 * 60_000);
  assert.equal(clampCheckInterval(1), 60 * 60_000);
  assert.equal(clampCheckInterval(Number.MAX_SAFE_INTEGER), CHECK_MAX_INTERVAL_MS);
  // An explicit fallback is trusted for a schedule that has one of its own.
  assert.equal(clampCheckInterval(undefined, 90 * 60_000), 90 * 60_000);
});
