import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BunnyClient, BunnyVideo } from '../src/bunny';
import { Catalog, type CatalogEntry } from '../src/catalog';
import type { AppConfig } from '../src/config';
import { JobService } from '../src/jobs';
import { Store } from '../src/store';
import { testConfig, testStreamDeps, waitFor } from './helpers';

interface FakeUploadOptions {
  title: string;
  fileName?: string;
  resumeUrl?: string;
  onUploadUrl?: (uploadUrl: string) => void;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  shouldContinue?: () => boolean;
}

class FakeBunny {
  created: string[] = [];
  createCalls = 0;
  uploads = 0;
  tusUploads = 0;
  putUploads = 0;
  fetches = 0;
  statuses = new Map<string, number>();
  failNext = false;
  /** Everything the library holds, including videos Bunny created for a fetch. */
  library: BunnyVideo[] = [];
  /** The next N upload attempts die with a connection error. */
  failUploads = 0;
  /** Held open so tests can observe a job mid-upload. */
  hold: Promise<void> | undefined;
  resumeCalls: Array<{ videoId: string; resumeUrl?: string }> = [];

  async createVideo(title: string): Promise<BunnyVideo> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Bunny said no');
    }
    this.createCalls += 1;
    const guid = `video-${this.created.length + 1}`;
    this.created.push(guid);
    this.statuses.set(guid, 0);
    return { guid, title, status: 0, encodeProgress: 0, length: 0 };
  }

  async uploadVideo(): Promise<void> {
    this.putUploads += 1;
    this.uploads += 1;
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      throw new Error('connection reset');
    }
  }

  async uploadVideoResumable(videoId: string, _filePath: string, options: FakeUploadOptions): Promise<{ uploadUrl: string; bytesSent: number; totalBytes: number; resumed: boolean }> {
    this.tusUploads += 1;
    this.uploads += 1;
    const call: { videoId: string; resumeUrl?: string } = { videoId };
    if (options.resumeUrl) call.resumeUrl = options.resumeUrl;
    this.resumeCalls.push(call);
    const uploadUrl = `https://video.bunnycdn.com/tusupload/${videoId}`;
    options.onUploadUrl?.(uploadUrl);
    options.onProgress?.(50, 100);
    if (this.hold) await this.hold;
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      throw new Error('connection reset');
    }
    return { uploadUrl, bytesSent: 100, totalBytes: 100, resumed: Boolean(options.resumeUrl) };
  }

  async fetchFromUrl(_url: string, title?: string): Promise<{ success: boolean }> {
    this.fetches += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Bunny said no');
    }
    // Bunny's fetch endpoint creates the video itself and returns no id: the
    // fake mirrors that, and the job is expected to find it by title.
    const guid = `fetched-${this.created.length + 1}`;
    this.created.push(guid);
    this.statuses.set(guid, 0);
    this.library.push({ guid, title: title ?? guid, status: 0, encodeProgress: 0, length: 0, dateUploaded: new Date().toISOString() });
    return { success: true };
  }

  async listVideos(limit = 1): Promise<{ totalItems?: number; items?: BunnyVideo[] }> {
    const items = [...this.library]
      .sort((a, b) => String(b.dateUploaded ?? '').localeCompare(String(a.dateUploaded ?? '')))
      .slice(0, Math.max(1, Math.floor(limit)));
    return { totalItems: this.library.length, items };
  }

  async getVideo(videoId: string): Promise<BunnyVideo> {
    const status = this.statuses.get(videoId) ?? 0;
    return { guid: videoId, title: 'mock', status, encodeProgress: status >= 4 ? 100 : 40, length: 10 };
  }

  async deleteVideo(): Promise<void> {
    /* nothing to clean up in the fake */
  }
}

function setup(
  overrides: Partial<AppConfig> = {},
  onPublished?: (entry: CatalogEntry) => void,
): { config: AppConfig; store: Store; fake: FakeBunny; service: JobService; catalog: Catalog } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-jobs-'));
  const config = testConfig(dir, overrides);
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const store = new Store(config);
  store.updateSettings({ perAccountConcurrency: 10, maxAccounts: 30 });
  const fake = new FakeBunny();
  const catalog = new Catalog(config);
  const service = new JobService({
    store,
    config,
    clientFactory: () => fake as unknown as BunnyClient,
    catalog,
    ...(onPublished ? { onPublished } : {}),
    ...testStreamDeps(dir),
  });
  return { config, store, fake, service, catalog };
}

test('a file job flows queued → encoding → ready and cleans up its temp file', async () => {
  const { config, store, fake, service } = setup();
  const account = store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'clip.mp4');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));

  const job = service.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, clip, 'clip.mp4', 16);
  assert.equal(store.job(job.id)?.status, 'queued');

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the job to start encoding');
  assert.equal(fake.uploads, 1);
  assert.equal(store.job(job.id)?.accountId, account.id);
  assert.equal(store.job(job.id)?.bunnyVideoId, fake.created[0]);

  fake.statuses.set(fake.created[0] as string, 4);
  await service.pollNow();
  assert.equal(store.job(job.id)?.status, 'ready');
  assert.equal(store.job(job.id)?.progress, 100);
  assert.equal(fs.existsSync(clip), false);
});

test('a published job is written to the permanent catalogue when it turns ready', async () => {
  const { store, fake, service, catalog } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const job = service.createUrlJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, 'https://example.com/inception.mp4');

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the fetch to complete');
  assert.equal(catalog.size, 0, 'nothing is recorded until Bunny has actually finished');

  for (const guid of fake.created) fake.statuses.set(guid, 4);
  await service.pollNow();
  assert.equal(store.job(job.id)?.status, 'ready');

  const entry = catalog.get('movie:27205');
  assert.ok(entry, 'the published movie has a catalogue record');
  assert.equal(entry?.title, 'Inception');
  assert.equal(entry?.year, '2010');
  assert.equal(entry?.videoId, store.job(job.id)?.bunnyVideoId);
  assert.equal(entry?.accountName, 'a');
  assert.equal(entry?.libraryId, '1');
  assert.equal(entry?.jobId, job.id);
  assert.equal(entry?.publishes, 1);
});

test('a finished publish hands its catalogue entry to the repair hook', async () => {
  const published: CatalogEntry[] = [];
  const { store, fake, service } = setup({}, (entry) => published.push(entry));
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const job = service.createUrlJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, 'https://example.com/inception.mp4');

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the fetch to complete');
  assert.equal(published.length, 0, 'nothing is handed over before Bunny has finished');

  // What a publish that attached the source track and missed the target looks
  // like by the time the hook runs: the entry, its tracks and all.
  store.updateJob(job.id, {
    subtitles: [{ srclang: 'en', label: 'English', url: 'https://example.com/en.vtt', uploaded: true, cues: 2, bytes: 40 }],
  });
  for (const guid of fake.created) fake.statuses.set(guid, 4);
  await service.pollNow();

  assert.equal(published.length, 1);
  assert.equal(published[0]?.key, 'movie:27205');
  assert.equal(published[0]?.videoId, store.job(job.id)?.bunnyVideoId);
  assert.deepEqual(published[0]?.subtitles?.map((track) => track.srclang), ['en']);
});

test('a remote-URL job asks Bunny to fetch and never touches disk', async () => {
  const { store, fake, service } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const job = service.createUrlJob(
    { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 1, episodeTitle: 'Pilot' },
    'https://example.com/s01e01.mp4',
  );

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the fetch to complete');
  assert.equal(fake.fetches, 1);
  assert.equal(fake.uploads, 0);
  assert.equal(store.job(job.id)?.source.kind, 'url');
});

test('no more than 10 jobs run at once on a single account', async () => {
  const { store, fake, service } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });

  for (let index = 0; index < 25; index += 1) {
    service.createUrlJob({ kind: 'movie', tmdbId: index + 1, title: `Movie ${index + 1}` }, 'https://example.com/movie.mp4');
  }

  service.tickNow();
  await waitFor(() => store.jobs.filter((job) => job.status === 'encoding').length === 10, 'ten concurrent encodings');
  assert.equal(store.jobs.filter((job) => job.status === 'queued').length, 15);

  for (const guid of fake.created) fake.statuses.set(guid, 4);
  await service.pollNow();
  assert.equal(store.jobs.filter((job) => job.status === 'ready').length, 10);

  service.tickNow();
  await waitFor(() => store.jobs.filter((job) => job.status === 'encoding').length === 10, 'the next ten encodings');
  assert.equal(store.jobs.filter((job) => job.status === 'queued').length, 5);
});

test('a failed job records the error and can be retried', async () => {
  const { store, fake, service } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  fake.failNext = true;

  const job = service.createUrlJob({ kind: 'movie', tmdbId: 603, title: 'The Matrix' }, 'https://example.com/matrix.mp4');
  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'failed', 'the job to fail');
  assert.match(store.job(job.id)?.error ?? '', /Bunny said no/);

  const retried = service.retry(job.id);
  assert.equal(retried?.status, 'queued');
  assert.equal(retried?.error, undefined);

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the retry to start');
  assert.equal(fake.created.length, 1);
});

test('a file job uploads over TUS and reports progress while uploading', async () => {
  const { config, store, fake, service } = setup();
  const account = store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'clip.mp4');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));
  let release!: () => void;
  fake.hold = new Promise((resolve) => {
    release = resolve;
  });

  const job = service.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, clip, 'clip.mp4', 16);
  service.tickNow();
  await waitFor(() => store.job(job.id)?.progress === 50, 'upload progress to be recorded');

  const uploading = store.job(job.id);
  assert.equal(uploading?.status, 'uploading');
  assert.equal(fake.tusUploads, 1);
  assert.equal(fake.putUploads, 0);
  assert.equal(fake.resumeCalls[0]?.resumeUrl, undefined);
  assert.equal(uploading?.tusUploadUrl, `https://video.bunnycdn.com/tusupload/${fake.created[0]}`);
  assert.equal(uploading?.resumeAccountId, account.id);

  release();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the job to start encoding');
});

test('a failed resumable upload keeps its session and resumes on retry', async () => {
  const { config, store, fake, service } = setup();
  const account = store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'movie.mkv');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));
  fake.failUploads = 1;

  const job = service.createFileJob({ kind: 'movie', tmdbId: 603, title: 'The Matrix' }, clip, 'movie.mkv', 16);
  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'failed', 'the upload to fail');

  const failed = store.job(job.id);
  assert.match(failed?.error ?? '', /connection reset/);
  assert.equal(failed?.bunnyVideoId, fake.created[0]);
  assert.equal(failed?.resumeAccountId, account.id);
  assert.ok(failed?.tusUploadUrl, 'the upload session is remembered');
  assert.equal(fs.existsSync(clip), true, 'the temp file survives so the retry can resume');

  const retried = service.retry(job.id);
  assert.equal(retried?.status, 'queued');
  assert.equal(retried?.accountId, account.id);

  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the resumed upload to reach Bunny');
  assert.equal(fake.createCalls, 1, 'a resume must reuse the video object it started');
  assert.equal(fake.tusUploads, 2);
  assert.equal(fake.resumeCalls[1]?.videoId, fake.created[0]);
  assert.equal(fake.resumeCalls[1]?.resumeUrl, failed?.tusUploadUrl);
});

test('after a restart an interrupted upload resumes where it stopped', async () => {
  const { config, store, fake } = setup();
  const account = store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'movie.mp4');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));
  let release!: () => void;
  fake.hold = new Promise((resolve) => {
    release = resolve;
  });

  const before = new JobService({ store, config, clientFactory: () => fake as unknown as BunnyClient, ...testStreamDeps(config.dataDir) });
  const job = before.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception' }, clip, 'movie.mp4', 16);
  before.tickNow();
  await waitFor(() => store.job(job.id)?.progress === 50, 'the first attempt to be mid-upload');

  // A fresh process over the same data directory: nothing is in flight any more.
  const after = new JobService({ store, config, clientFactory: () => fake as unknown as BunnyClient, ...testStreamDeps(config.dataDir) });
  after.recover();
  const recovered = store.job(job.id);
  assert.equal(recovered?.status, 'queued');
  assert.equal(recovered?.accountId, account.id);
  assert.equal(recovered?.tusUploadUrl, `https://video.bunnycdn.com/tusupload/${fake.created[0]}`);
  assert.match(recovered?.error ?? '', /resume where it stopped/);

  release();
  after.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the upload to resume after the restart');
  assert.equal(fake.createCalls, 1, 'the restarted dashboard must not restart the upload');
  assert.equal(fake.resumeCalls.at(-1)?.resumeUrl, recovered?.tusUploadUrl);
});

test('startup sweeps temp files whose job no longer exists', () => {
  const { config, store, service } = setup();
  const referenced = path.join(config.uploadsDir, 'referenced.bin');
  fs.writeFileSync(referenced, Buffer.from('waiting to upload'));
  const orphan = path.join(config.uploadsDir, 'orphan.bin');
  fs.writeFileSync(orphan, Buffer.from('stale bytes'));
  const foreign = path.join(config.uploadsDir, 'notes.txt');
  fs.writeFileSync(foreign, Buffer.from('do not touch'));

  const job = service.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception' }, referenced, 'referenced.bin', 17);
  service.recover();

  assert.ok(store.job(job.id), 'the queued job survives the sweep');
  assert.equal(fs.existsSync(referenced), true, 'a referenced temp file is kept');
  assert.equal(fs.existsSync(orphan), false, 'an orphaned .bin file is removed');
  assert.equal(fs.existsSync(foreign), true, 'files that are not ours are left alone');
});

test('UPLOAD_MODE=put still uploads in a single request', async () => {
  const { config, store, fake, service } = setup({ uploadMode: 'put' });
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'clip.mp4');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));

  const job = service.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception' }, clip, 'clip.mp4', 16);
  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'encoding', 'the PUT upload to finish');
  assert.equal(fake.putUploads, 1);
  assert.equal(fake.tusUploads, 0);
  assert.equal(store.job(job.id)?.tusUploadUrl, undefined);
});

test('a failed upload in put mode still discards its temp file', async () => {
  const { config, store, fake, service } = setup({ uploadMode: 'put' });
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  const clip = path.join(config.uploadsDir, 'clip.mp4');
  fs.writeFileSync(clip, Buffer.from('fake video bytes'));
  fake.failUploads = 1;

  const job = service.createFileJob({ kind: 'movie', tmdbId: 27205, title: 'Inception' }, clip, 'clip.mp4', 16);
  service.tickNow();
  await waitFor(() => store.job(job.id)?.status === 'failed', 'the PUT upload to fail');
  assert.equal(fs.existsSync(clip), false, 'a non-resumable failure cleans up after itself');

  const retried = service.retry(job.id);
  assert.equal(retried?.bunnyVideoId, undefined, 'a put-mode retry starts a new video object');
});

test('a video is named by its TMDB id, so one library stays joinable', async () => {
  const { store, fake, service } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });

  // Bunny creates the video for a fetch itself, so the title it was given is
  // observable in the fake library.
  const movie = service.createUrlJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, 'https://example.com/inception.mp4');
  service.tickNow();
  await waitFor(() => store.job(movie.id)?.status === 'encoding', 'the movie fetch to complete');
  assert.equal(fake.library[0]?.title, 'tmdb:27205');

  const episode = service.createUrlJob(
    { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 2, episodeTitle: 'Pilot' },
    'https://example.com/bb.mp4',
  );
  service.tickNow();
  await waitFor(() => store.job(episode.id)?.status === 'encoding', 'the episode fetch to complete');
  assert.equal(fake.library[1]?.title, 'tv:1396:S01E02');
  // The readable title still travels with the job — only the library name is an id.
  assert.equal(store.job(episode.id)?.target.title, 'Breaking Bad');
  assert.equal(store.job(episode.id)?.target.episodeTitle, 'Pilot');
});

/**
 * The tick is where the dashboard used to die.
 *
 * Starting a job writes the database from inside the one-second interval, and a
 * write that failed there threw out of the timer callback — an uncaught
 * exception, so the process ended and, under `restart: unless-stopped` (or any
 * platform restart policy), came back with the job requeued. To the operator
 * that is "it restarted itself while too many things were running". A tick now
 * costs one log line and the queue keeps moving.
 */
test('a tick survives a data folder that refuses the write', () => {
  const { config, store, service } = setup();
  store.addAccount({ name: 'a', libraryId: '1', apiKeyEnc: 'x' });
  // A disk that will not take the write, exactly as a full one behaves.
  fs.mkdirSync(`${config.dbPath}.tmp`);
  const job = service.createUrlJob({ kind: 'movie', tmdbId: 99, title: 'Tick Test' }, 'https://example.test/tick.mp4');

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => service.tickNow(), 'the tick keeps the process alive');
  } finally {
    console.error = originalError;
  }

  assert.equal(store.job(job.id)?.status, 'uploading', 'and the job still started');
  assert.ok(store.writeHealth.failures >= 1, 'the failed write is reported, not hidden');
});
