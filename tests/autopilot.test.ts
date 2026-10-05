import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Autopilot, AutopilotError, type AutopilotJobs } from '../src/autopilot';
import { Store, newJob, targetKey, type Job, type JobTarget } from '../src/store';
import type { TmdbClient, TmdbSearchResult, TmdbTopRated } from '../src/tmdb';
import { testConfig } from './helpers';

/** Records what the autopilot queued and retried, and remembers queued identities. */
class FakeJobs implements AutopilotJobs {
  created: JobTarget[] = [];
  retried: string[] = [];
  private queued = new Set<string>();

  createStreamJob(target: JobTarget): Job {
    this.created.push(target);
    this.queued.add(targetKey(target));
    return { id: `job-${this.created.length}` } as Job;
  }

  retry(jobId: string): Job | undefined {
    this.retried.push(jobId);
    return { id: jobId } as Job;
  }

  get keys(): Set<string> {
    return new Set(this.queued);
  }
}

function entry(tmdbId: number, title: string, voteAverage?: number): TmdbSearchResult {
  return {
    tmdbId,
    mediaType: 'movie',
    title,
    year: '2020',
    overview: '',
    posterPath: null,
    ...(voteAverage !== undefined ? { voteAverage } : {}),
  };
}

function page(results: TmdbSearchResult[]): TmdbTopRated {
  return { results, page: 1, totalPages: 1 };
}

/** A TMDB stand-in: fixed pages per kind, plus one show with two episodes. */
function fakeTmdb(pages: { movie?: TmdbTopRated[]; tv?: TmdbTopRated[] }): TmdbClient {
  return {
    async topRated(kind: 'movie' | 'tv', index: number) {
      const list = pages[kind] ?? [];
      return list[index - 1] ?? { results: [], page: index, totalPages: Math.max(1, list.length) };
    },
    async tv(id: number) {
      return {
        tmdbId: id,
        title: 'Top show',
        year: '2020',
        overview: '',
        posterPath: null,
        seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 2, posterPath: null }],
      };
    },
    async season() {
      return [
        { episodeNumber: 1, name: 'One', overview: '', stillPath: null },
        { episodeNumber: 2, name: 'Two', overview: '', stillPath: null },
      ];
    },
  } as unknown as TmdbClient;
}

function setup(pages: { movie?: TmdbTopRated[]; tv?: TmdbTopRated[] }, overrides: Partial<ReturnType<typeof testConfig>> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-autopilot-'));
  const config = testConfig(dir, overrides);
  const store = new Store(config);
  const jobs = new FakeJobs();
  const autopilot = new Autopilot({ config, store, jobs, tmdb: () => fakeTmdb(pages), doneKeys: () => jobs.keys });
  autopilot.updateConfig({ enabled: true });
  return { dir, config, store, jobs, autopilot };
}

test('only titles that clear the rating floor are queued, best rating first', async () => {
  const { autopilot, jobs } = setup({
    movie: [page([entry(1, 'Great', 9.1), entry(2, 'Good', 8.2), entry(3, 'Ok', 5.4), entry(4, 'Poor', 2.6), entry(5, 'Unrated')])],
  });
  const report = await autopilot.runCycle();

  assert.deepEqual(
    jobs.created.map((target) => target.title),
    ['Great', 'Good', 'Ok'],
    'the 2.6 and the unrated title are both below a floor of 3',
  );
  assert.equal(report.created, 3);
  assert.equal(report.belowRating, 2);
  assert.equal(report.scanned, 5);
  assert.equal(report.paused, false);
  assert.ok(report.skipped.some((skip) => skip.reason === 'no rating yet'), 'an unrated title says why');
});

test('the per-cycle cap is respected and the unfinished page is picked up again', async () => {
  const { autopilot, jobs } = setup(
    { movie: [page([entry(1, 'A', 9), entry(2, 'B', 8), entry(3, 'C', 7), entry(4, 'D', 6)])] },
    { scrapeMinIntervalMs: 0 },
  );
  autopilot.updateConfig({ maxJobsPerCycle: 2 });

  const first = await autopilot.runCycle();
  assert.equal(first.created, 2);
  assert.equal(autopilot.stateView().cursors.movie, 1, 'the cursor stays on a page it could not finish');

  const second = await autopilot.runCycle();
  assert.equal(second.created, 2, 'the next cycle continues the same page');
  assert.deepEqual(jobs.created.map((target) => target.title), ['A', 'B', 'C', 'D']);
  assert.equal(second.alreadyDone, 2, 'the two already queued are stepped over');
  assert.equal(autopilot.stateView().cursors.movie, 2, 'and then the cursor moves on');
});

test('with nothing new to queue, the failed jobs are retried automatically', async () => {
  const { autopilot, store, jobs } = setup({ movie: [page([entry(1, 'Done', 9)])] });
  // The only title on the list is already queued, and one job has failed.
  jobs.createStreamJob({ kind: 'movie', tmdbId: 1, title: 'Done' });
  const failed = store.addJob(newJob({ kind: 'movie', tmdbId: 99, title: 'Failed' }, { kind: 'stream', mode: 'scrape', name: 'x' }));
  store.updateJob(failed.id, { status: 'failed', error: 'no source' });

  const report = await autopilot.runCycle();
  assert.equal(report.created, 0);
  assert.equal(report.retried, 1);
  assert.deepEqual(jobs.retried, [failed.id]);
  assert.match(report.note, /retried 1 failed job/, 'the report says what the cycle did instead');
});

test('a job that has been tried enough is given up on, and the list starts over', async () => {
  const { autopilot, store, jobs } = setup({ movie: [page([entry(1, 'Done', 9)])] });
  jobs.createStreamJob({ kind: 'movie', tmdbId: 1, title: 'Done' });
  const hopeless = store.addJob(newJob({ kind: 'movie', tmdbId: 98, title: 'Hopeless' }, { kind: 'stream', mode: 'scrape', name: 'x' }));
  store.updateJob(hopeless.id, { status: 'failed', error: 'always fails', attempts: 5 });

  const report = await autopilot.runCycle();
  assert.equal(report.retried, 0);
  assert.equal(report.abandoned, 1);
  assert.equal(report.wrapped, true, 'nothing to do at all, so it starts the list over');
  assert.equal(autopilot.stateView().cursors.movie, 1);
});

test('reaching the end of a list wraps back to page one', async () => {
  const { autopilot } = setup({ movie: [page([entry(1, 'Only', 9)])] });
  const report = await autopilot.runCycle();
  assert.equal(report.created, 1);
  assert.equal(report.wrapped, true, 'page two does not exist, so the list wrapped');
  assert.equal(autopilot.stateView().cursors.movie, 1);
});

test('a deep queue pauses the autopilot instead of piling more work on', async () => {
  const { autopilot, store, jobs } = setup({ movie: [page([entry(1, 'A', 9)])] });
  autopilot.updateConfig({ maxQueueDepth: 1 });
  store.addJob(newJob({ kind: 'movie', tmdbId: 42, title: 'Already queued' }, { kind: 'file', name: 'x.bin' }));

  const report = await autopilot.runCycle();
  assert.equal(report.paused, true);
  assert.equal(report.created, 0);
  assert.equal(jobs.created.length, 0);
  assert.match(report.note, /unfinished/);
});

test('a show expands to its episodes', async () => {
  const show: TmdbSearchResult = { tmdbId: 1396, mediaType: 'tv', title: 'Top show', year: '2020', overview: '', posterPath: null, voteAverage: 9.2 };
  const { autopilot, jobs } = setup({ tv: [{ results: [show], page: 1, totalPages: 1 }] });
  autopilot.updateConfig({ kinds: ['tv'] });

  const report = await autopilot.runCycle();
  assert.equal(report.created, 2);
  assert.deepEqual(
    jobs.created.map((target) => `${target.title} S${target.season}E${target.episode}`),
    ['Top show S1E1', 'Top show S1E2'],
  );
});

test('config and cursors survive a restart, and nonsense is rejected', async () => {
  const { dir, config, store, jobs, autopilot } = setup({ movie: [page([entry(1, 'A', 9)])] });
  autopilot.updateConfig({ minRating: 7, maxJobsPerCycle: 3, kinds: ['movie'] });
  await autopilot.runCycle();

  const reloaded = new Autopilot({ config, store, jobs, tmdb: () => fakeTmdb({}), doneKeys: () => jobs.keys });
  const state = reloaded.stateView();
  assert.equal(state.config.minRating, 7);
  assert.equal(state.config.maxJobsPerCycle, 3);
  assert.deepEqual(state.config.kinds, ['movie']);
  assert.equal(state.cycle, 1, 'the cycle counter is remembered');
  assert.ok(fs.existsSync(path.join(dir, 'autopilot.json')));

  assert.throws(() => reloaded.updateConfig({ minRating: 42 }), AutopilotError);
  assert.throws(() => reloaded.updateConfig({ kinds: [] }), AutopilotError);
  assert.throws(() => reloaded.updateConfig({ intervalMs: 10 }), AutopilotError);
});

test('a switched-off autopilot does nothing at all', async () => {
  const { autopilot, jobs } = setup({ movie: [page([entry(1, 'A', 9)])] });
  autopilot.updateConfig({ enabled: false });
  const report = await autopilot.runCycle();
  assert.equal(report.created, 0);
  assert.equal(jobs.created.length, 0);
  assert.match(report.note, /switched off/);
});
