import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { JobTarget, Store } from '../src/store';
import { Store as StoreClass } from '../src/store';
import type { AppConfig } from '../src/config';
import { FolderWatcher, MIN_MATCH_SCORE, bestMatch, copyIntoUploads, isVideoFile, parseReleaseName, scoreCandidate } from '../src/watch';
import { TmdbClient, type TmdbSearchResult, type TmdbEpisode, type TmdbMovie, type TmdbShow } from '../src/tmdb';
import { testConfig } from './helpers';

/* ------------------------------ parsing ------------------------------ */

test('release names lose their tags but keep title, year and episode numbers', () => {
  assert.deepEqual(parseReleaseName('Inception.2010.1080p.BluRay.x264-AMIABLE.mkv'), { title: 'Inception', year: '2010' });
  assert.deepEqual(parseReleaseName('The Matrix (1999) [1080p] [BluRay].mp4'), { title: 'The Matrix', year: '1999' });
  assert.deepEqual(parseReleaseName('Some.Movie.1920x1080.WEB-DL.mkv'), { title: 'Some Movie' });
  assert.deepEqual(parseReleaseName('No Year Or Episode Here.mkv'), { title: 'No Year Or Episode Here' });
  assert.deepEqual(parseReleaseName('Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos.TrueHD.7.1.mkv'), { title: 'Interstellar', year: '2014' });
});

test('episode names are recognised in the common shapes', () => {
  assert.deepEqual(parseReleaseName('Breaking.Bad.S01E02.2160p.WEB-DL.DDP5.1.HDR.x265-GROUP.mkv'), { title: 'Breaking Bad', season: 1, episode: 2 });
  assert.deepEqual(parseReleaseName('Show Name - 1x02 - Episode Title.mkv'), { title: 'Show Name', season: 1, episode: 2 });
  assert.deepEqual(parseReleaseName('Arcane Season 1 Episode 3 1080p.mkv'), { title: 'Arcane', season: 1, episode: 3 });
  assert.deepEqual(parseReleaseName('Stranger Things S04E09 1080p WEB h264.mkv'), { title: 'Stranger Things', season: 4, episode: 9 });
});

test('a season without episode numbers is flagged instead of guessed', () => {
  assert.deepEqual(parseReleaseName('Breaking.Bad.S02.1080p.BluRay.mkv'), { title: 'Breaking Bad', seasonOnly: true });
  assert.deepEqual(parseReleaseName('1080p.mkv'), { title: '' });
});

test('only video containers are considered', () => {
  assert.equal(isVideoFile('movie.mkv'), true);
  assert.equal(isVideoFile('movie.MP4'), true);
  assert.equal(isVideoFile('movie.m2ts'), true);
  assert.equal(isVideoFile('notes.txt'), false);
  assert.equal(isVideoFile('poster.jpg'), false);
});

/* ------------------------------ matching ------------------------------ */

function candidate(partial: Partial<TmdbSearchResult> & { title: string }): TmdbSearchResult {
  return { tmdbId: 1, mediaType: 'movie', overview: '', posterPath: null, ...partial };
}

test('the exact title with the matching year wins', () => {
  const parsed = parseReleaseName('Inception.2010.1080p.mkv');
  const older = candidate({ tmdbId: 10, title: 'Inception', year: '1999' });
  const exact = candidate({ tmdbId: 20, title: 'Inception', year: '2010' });
  assert.equal(bestMatch([older, exact], parsed)?.tmdbId, 20);
});

test('episode names only match shows, and loose titles need a year', () => {
  const episode = parseReleaseName('Breaking.Bad.S01E02.1080p.mkv');
  assert.equal(scoreCandidate(candidate({ title: 'Breaking Bad' }), episode), undefined);
  assert.equal(bestMatch([candidate({ title: 'Breaking Bad' })], episode), undefined);
  assert.equal(bestMatch([candidate({ title: 'Breaking Bad', mediaType: 'tv' })], episode)?.mediaType, 'tv');

  const loose = parseReleaseName('Batman Forever Special Edition.mkv');
  assert.ok((scoreCandidate(candidate({ title: 'Batman Forever' }), loose) ?? 0) < MIN_MATCH_SCORE, 'a partial title alone is not enough');
  assert.equal(bestMatch([candidate({ title: 'Batman Forever' })], loose), undefined);
  assert.equal(bestMatch([candidate({ title: 'Batman Forever', year: '1995' })], parseReleaseName('Batman.Forever.1995.mkv'))?.title, 'Batman Forever');
});

test('unrelated results are never matched', () => {
  const parsed = parseReleaseName('Inception.2010.mkv');
  assert.equal(bestMatch([candidate({ title: 'The Inception of Everything Else' })], parsed), undefined);
  assert.equal(bestMatch([], parsed), undefined);
});

test('the cross-drive copy keeps the bytes and only then removes the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-copy-'));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const source = path.join(root, 'Inception.2010.mkv');
  const bytes = Buffer.alloc(4096, 9);
  fs.writeFileSync(source, bytes);

  const target = copyIntoUploads(source, uploads);

  assert.equal(path.dirname(target), uploads);
  assert.ok(fs.readFileSync(target).equals(bytes), 'the copy must be byte-for-byte');
  assert.equal(fs.existsSync(source), false, 'the source is only removed after a verified copy');
  assert.deepEqual(fs.readdirSync(uploads), [path.basename(target)], 'nothing else is left behind');
});

/* ------------------------------ watcher ------------------------------ */

interface Enqueued {
  target: JobTarget;
  tempPath: string;
  name: string;
  bytes: number;
}

function stubTmdb(overrides: Partial<Record<'search' | 'movie' | 'tv' | 'season', unknown>> = {}): TmdbClient {
  return {
    search: async (): Promise<TmdbSearchResult[]> => [],
    movie: async (id: number): Promise<TmdbMovie> => ({ tmdbId: id, title: 'Stub movie', overview: '', posterPath: null, genres: [] }),
    tv: async (id: number): Promise<TmdbShow> => ({ tmdbId: id, title: 'Stub show', overview: '', posterPath: null, seasons: [] }),
    season: async (): Promise<TmdbEpisode[]> => [],
    ...overrides,
  } as unknown as TmdbClient;
}

function setup(options: { tmdb?: TmdbClient; watchMinAgeMs?: number; now?: () => number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const config: AppConfig = testConfig(root, {
    watchDir: path.join(root, 'incoming'),
    watchIntervalMs: 60_000,
    watchMinAgeMs: options.watchMinAgeMs ?? 0,
  });
  const watchDir = config.watchDir as string;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(watchDir, { recursive: true });
  const store: Store = new StoreClass(config);
  const enqueued: Enqueued[] = [];
  const watcher = new FolderWatcher({
    config,
    store,
    tmdb: () => options.tmdb ?? new TmdbClient({}, { mock: true }),
    enqueue: (target, tempPath, name, bytes) => {
      enqueued.push({ target, tempPath, name, bytes });
      return { id: `job-${enqueued.length}` };
    },
    ...(options.now ? { now: options.now } : {}),
  });
  const drop = (name: string, contents = 'video bytes') => {
    const full = path.join(watchDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(contents));
    return full;
  };
  return { config, root, watchDir, store, watcher, enqueued, drop };
}

test('a movie file is matched by name, moved out of the folder and queued', async () => {
  const { config, watchDir, watcher, enqueued, drop } = setup();
  const source = drop('Inception.2010.1080p.BluRay.x264.mkv', 'movie bytes here');

  await watcher.scan();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]?.target, { kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' });
  assert.equal(enqueued[0]?.name, 'Inception.2010.1080p.BluRay.x264.mkv');
  assert.equal(enqueued[0]?.bytes, 16);
  assert.equal(fs.existsSync(source), false, 'the watched file moves into the queue');
  assert.ok(enqueued[0]?.tempPath.startsWith(config.uploadsDir));
  assert.equal(fs.statSync(enqueued[0]?.tempPath as string).size, 16);
  assert.equal(fs.readFileSync(enqueued[0]?.tempPath as string, 'utf8'), 'movie bytes here');

  const state = watcher.state();
  assert.equal(state.enabled, true);
  assert.equal(state.dir, path.resolve(watchDir));
  assert.equal(state.counts.queued, 1);
  assert.equal(state.counts.unmatched, 0);
  assert.equal(state.files[0]?.name, 'Inception.2010.1080p.BluRay.x264.mkv');
  assert.equal(state.files[0]?.status, 'queued');
  assert.equal(state.files[0]?.jobId, 'job-1');
  assert.ok(state.lastScanAt);
});

test('an episode file queues that exact episode of the matched show', async () => {
  const { watcher, enqueued, drop } = setup();
  drop('Breaking.Bad.S01E02.2160p.WEB-DL.DDP5.1.HDR.x265-GROUP.mkv');

  await watcher.scan();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]?.target, {
    kind: 'episode',
    tmdbId: 1396,
    title: 'Breaking Bad',
    season: 1,
    episode: 2,
    episodeTitle: 'Episode 2',
    year: '2008',
  });
});

test('files below the surface of the folder are found too', async () => {
  const { watcher, enqueued, drop } = setup();
  drop(path.join('Inception (2010)', 'Inception.2010.1080p.mkv'));

  await watcher.scan();

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.target.tmdbId, 27205);
  assert.equal(watcher.state().files[0]?.name, path.join('Inception (2010)', 'Inception.2010.1080p.mkv'));
});

test('non-video files and samples are ignored', async () => {
  const { watcher, enqueued, drop } = setup();
  drop('notes.txt');
  drop('poster.jpg');
  drop('Inception.2010.sample.mkv');

  await watcher.scan();

  assert.equal(enqueued.length, 0);
  assert.equal(watcher.state().files.length, 0);
});

test('an unresolved file stays put, is reported, and is retried later', async () => {
  let searches = 0;
  const tmdb = stubTmdb({
    search: async () => {
      searches += 1;
      return [];
    },
  });
  let now = Date.now();
  const { watcher, enqueued, drop } = setup({ tmdb, now: () => now });
  const source = drop('Totally Unknown Thing 2020 1080p.mkv');
  now = Date.now();

  await watcher.scan();
  assert.equal(enqueued.length, 0);
  assert.equal(fs.existsSync(source), true, 'an unmatched file is never moved');
  assert.equal(watcher.state().files[0]?.status, 'unmatched');
  assert.match(watcher.state().files[0]?.error ?? '', /no confident TMDB match/);
  assert.equal(searches, 1);

  await watcher.scan();
  assert.equal(searches, 1, 'the retry back-off keeps TMDB quiet');

  now += 6 * 60_000;
  await watcher.scan();
  assert.equal(searches, 2, 'the file is retried once the back-off passes');

  await watcher.scan({ retryUnmatched: true });
  assert.equal(searches, 3, 'the Retry button overrides the back-off');
  assert.ok((watcher.state().files[0]?.attempts ?? 0) >= 3);
});

test('a season TMDB does not know is reported instead of queued', async () => {
  const { watcher, enqueued, drop } = setup();
  const source = drop('Breaking.Bad.S09E01.1080p.mkv');

  await watcher.scan();

  assert.equal(enqueued.length, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(watcher.state().files[0]?.status, 'unmatched');
  assert.match(watcher.state().files[0]?.error ?? '', /no season 9/);
});

test('a whole-season file asks for episode numbers', async () => {
  const { watcher, enqueued, drop } = setup();
  const source = drop('Breaking.Bad.S02.1080p.BluRay.mkv');

  await watcher.scan();

  assert.equal(enqueued.length, 0);
  assert.equal(fs.existsSync(source), true);
  assert.match(watcher.state().files[0]?.error ?? '', /SxxExx/);
});

test('a TMDB failure leaves the file for the next scan', async () => {
  const tmdb = stubTmdb({
    search: async () => {
      throw new Error('TMDB is not configured — add an API key or access token in Settings.');
    },
  });
  const { watcher, enqueued, drop } = setup({ tmdb });
  const source = drop('Inception.2010.mkv');

  await watcher.scan();

  assert.equal(enqueued.length, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(watcher.state().files[0]?.status, 'error');
  assert.match(watcher.state().files[0]?.error ?? '', /not configured/);
});

test('a fresh file is left alone until it stops changing', async () => {
  let now = Date.now();
  const { watcher, enqueued, drop } = setup({ watchMinAgeMs: 30_000, now: () => now });
  drop('Inception.2010.mkv');
  now = Date.now();

  await watcher.scan();
  assert.equal(enqueued.length, 0);
  assert.equal(watcher.state().files[0]?.status, 'waiting');

  now += 31_000;
  await watcher.scan();
  assert.equal(enqueued.length, 1);
  assert.equal(watcher.state().files[0]?.status, 'queued');
});

test('an empty file waits for the copy to finish', async () => {
  const { watcher, enqueued, drop } = setup();
  drop('Inception.2010.mkv', '');

  await watcher.scan();

  assert.equal(enqueued.length, 0);
  assert.equal(watcher.state().files[0]?.status, 'waiting');
});

test('a file is not queued twice when the folder is scanned again', async () => {
  const { watcher, enqueued, drop } = setup();
  drop('Inception.2010.mkv');

  await watcher.scan();
  await watcher.scan();

  assert.equal(enqueued.length, 1);
});

test('the same file name dropped again is queued again', async () => {
  const { watcher, enqueued, drop } = setup();
  drop('Inception.2010.mkv');

  await watcher.scan();
  assert.equal(enqueued.length, 1);

  drop('Inception.2010.mkv', 'a replaced copy of the movie');
  await watcher.scan();

  assert.equal(enqueued.length, 2, 'a new copy is new work, even under a known name');
  assert.equal(watcher.state().files[0]?.status, 'queued');
});

test('watching can be switched off and a bad folder is reported', async () => {
  const { config, store, watcher, enqueued, drop } = setup();
  const source = drop('Inception.2010.mkv');

  store.updateSettings({ watchEnabled: false });
  await watcher.scan();
  assert.equal(watcher.state().enabled, false);
  assert.equal(enqueued.length, 0);
  assert.equal(fs.existsSync(source), true);

  store.updateSettings({ watchEnabled: true, watchDir: path.join(config.root, 'nope') });
  await watcher.scan();
  assert.match(watcher.state().folderError ?? '', /does not exist/);

  store.updateSettings({ watchDir: config.uploadsDir });
  await watcher.scan();
  assert.match(watcher.state().folderError ?? '', /cannot be the uploads/);

  store.updateSettings({ watchDir: '' });
  await watcher.scan();
  assert.equal(watcher.state().enabled, false);
});

test('a failure while queueing puts the file back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-rollback-'));
  const config = testConfig(root, { watchDir: path.join(root, 'incoming'), watchMinAgeMs: 0, watchIntervalMs: 60_000 });
  const watchDir = config.watchDir as string;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(watchDir, { recursive: true });
  const store = new StoreClass(config);
  const watcher = new FolderWatcher({
    config,
    store,
    tmdb: () => new TmdbClient({}, { mock: true }),
    enqueue: () => {
      throw new Error('the store is read-only');
    },
  });
  const source = path.join(watchDir, 'Inception.2010.mkv');
  fs.writeFileSync(source, Buffer.from('movie bytes'));

  await watcher.scan();

  assert.equal(fs.existsSync(source), true, 'the file goes back so nothing is lost');
  assert.equal(fs.readdirSync(config.uploadsDir).length, 0);
  assert.equal(watcher.state().files[0]?.status, 'error');
  assert.match(watcher.state().files[0]?.error ?? '', /read-only/);
});
