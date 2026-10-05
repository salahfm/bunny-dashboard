/**
 * Bulk queuing: one pasted list becomes many TMDB targets.
 *
 * The rules under test are the ones an operator notices within a minute of using
 * it: a plain title is matched confidently or reported (never guessed), a show
 * becomes episodes — all of it, the one season a line pins, or the single episode
 * it names — and a title that is already in the queue is not queued twice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planBulk, planShow, queuedKeys, seasonFromLine, targetKey, withoutQueued } from '../src/bulk';
import { newJob, type Job, type JobTarget } from '../src/store';
import { TmdbClient } from '../src/tmdb';

function mockTmdb(): TmdbClient {
  // The canned dataset the rest of the suite uses: Breaking Bad has five seasons
  // of 7/13/13/13/16 episodes, Stranger Things 8/9/8/9.
  return new TmdbClient({}, { mock: true });
}

function jobFor(target: JobTarget, status: Job['status']): Job {
  return { ...newJob(target, { kind: 'url', name: 'queued.mp4', url: 'https://example.test/queued.mp4' }), status };
}

test('a plain title with a year resolves to that movie', async () => {
  const plan = await planBulk(mockTmdb(), ['Inception (2010)']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.queued.length, 1);
  assert.deepEqual(plan.queued[0]?.target, { kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' });
  assert.equal(plan.truncated, false);
});

test('ids and links are taken literally', async () => {
  const plan = await planBulk(mockTmdb(), ['27205', 'https://www.themoviedb.org/movie/603'], { expandSeries: false });
  assert.equal(plan.queued.length, 2);
  assert.deepEqual(plan.queued.map((entry) => entry.target.tmdbId), [27205, 603]);
  assert.equal(plan.queued[1]?.target.title, 'The Matrix');
});

test('a show becomes every episode of every season', async () => {
  const plan = await planBulk(mockTmdb(), ['Breaking Bad']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.queued.length, 62, '7 + 13 + 13 + 13 + 16 episodes');
  assert.deepEqual(plan.queued[0]?.target, {
    kind: 'episode',
    tmdbId: 1396,
    title: 'Breaking Bad',
    season: 1,
    episode: 1,
    year: '2008',
    episodeTitle: 'Episode 1',
  });
  const last = plan.queued.at(-1)?.target;
  assert.equal(last?.season, 5);
  assert.equal(last?.episode, 16);
  assert.equal(new Set(plan.queued.map((entry) => entry.target.season)).size, 5, 'every season is present');
});

test('a line that pins a season queues only that season', async () => {
  const plan = await planBulk(mockTmdb(), ['Breaking Bad S03']);
  assert.equal(plan.queued.length, 13);
  assert.ok(plan.queued.every((entry) => entry.target.season === 3 && entry.target.kind === 'episode'));
});

test('a line that names one episode queues one job', async () => {
  const plan = await planBulk(mockTmdb(), ['Breaking Bad S02E05']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.queued.length, 1);
  assert.deepEqual(plan.queued[0]?.target, {
    kind: 'episode',
    tmdbId: 1396,
    title: 'Breaking Bad',
    season: 2,
    episode: 5,
    year: '2008',
    episodeTitle: 'Episode 5',
  });
});

test('an unusable line is reported and the rest of the list still queues', async () => {
  const plan = await planBulk(mockTmdb(), ['tt9999999', 'Inception']);
  assert.equal(plan.queued.length, 1);
  assert.equal(plan.queued[0]?.target.tmdbId, 27205);
  assert.deepEqual(plan.skipped, [{ line: 'tt9999999', reason: 'TMDB has nothing for tt9999999' }]);
});

test('with series expansion off, shows are reported instead of guessed at', async () => {
  const plan = await planBulk(mockTmdb(), ['tt0903747', 'Inception'], { expandSeries: false });
  assert.equal(plan.queued.length, 1);
  assert.equal(plan.queued[0]?.target.title, 'Inception');
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0]?.reason ?? '', /series expansion is switched off/);
});

test('blank lines and comments are ignored, and the cap stops a huge list', async () => {
  const plan = await planBulk(mockTmdb(), ['', '   ', '# a note', 'Inception', 'Interstellar'], { maxJobs: 1 });
  assert.equal(plan.queued.length, 1);
  assert.equal(plan.queued[0]?.target.tmdbId, 27205);
  assert.equal(plan.truncated, true);
});

test('season pins are read from the end of a line only', () => {
  assert.equal(seasonFromLine('Breaking Bad S03'), 3);
  assert.equal(seasonFromLine('Breaking Bad season 4'), 4);
  assert.equal(seasonFromLine('Breaking Bad S02E05'), undefined, 'an episode marker is not a season pin');
  assert.equal(seasonFromLine('Inception'), undefined);
});

test('planShow takes a season list and reports one TMDB does not have', async () => {
  const targets = await planShow(mockTmdb(), 66732, { seasons: [2] });
  assert.equal(targets.length, 9);
  assert.ok(targets.every((target) => target.season === 2 && target.title === 'Stranger Things'));
  await assert.rejects(planShow(mockTmdb(), 66732, { seasons: [5] }), /no season 5/);
});

test('a target already in the queue is not queued twice', async () => {
  const plan = await planBulk(mockTmdb(), ['Breaking Bad S03']);
  assert.equal(plan.queued.length, 13);
  const existing = queuedKeys([
    jobFor({ kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 3, episode: 1 }, 'ready'),
  ]);
  const { fresh, skipped } = withoutQueued(plan.queued, existing);
  assert.equal(fresh.length, 12);
  assert.deepEqual(skipped, [{ line: 'Breaking Bad S03', reason: 'already in the queue' }]);
  assert.ok(fresh.every((entry) => entry.target.season === 3 && entry.target.episode !== 1));
});

test('one paste cannot queue the same episode twice', async () => {
  const plan = await planBulk(mockTmdb(), ['Breaking Bad S02E05', 'Breaking Bad S02E05']);
  assert.equal(plan.queued.length, 2);
  const { fresh, skipped } = withoutQueued(plan.queued, new Set());
  assert.equal(fresh.length, 1);
  assert.deepEqual(skipped, [{ line: 'Breaking Bad S02E05', reason: 'already in the queue' }]);
});

test('a failed or cancelled job does not block the title', () => {
  const movie: JobTarget = { kind: 'movie', tmdbId: 27205, title: 'Inception' };
  const keys = queuedKeys([
    jobFor(movie, 'failed'),
    jobFor({ kind: 'movie', tmdbId: 603, title: 'The Matrix' }, 'cancelled'),
    jobFor({ kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 1 }, 'queued'),
  ]);
  assert.equal(keys.has(targetKey(movie)), false, 'a failed job is a title worth queueing again');
  assert.equal(keys.size, 1, 'only the job that is actually in the queue blocks its target');
});
