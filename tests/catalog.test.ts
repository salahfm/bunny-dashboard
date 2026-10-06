import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Catalog, type CatalogArchive, type CatalogEntry } from '../src/catalog';
import { newJob, type Account, type Job } from '../src/store';
import { testConfig } from './helpers';

const ACCOUNT: Account = {
  id: 'acc-1',
  name: 'primary',
  libraryId: '123456',
  apiKeyEnc: 'enc',
  pullZoneHost: 'vz-x.b-cdn.net',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A job that has finished publishing, with everything the pipeline learned. */
function readyJob(): Job {
  const job = newJob(
    {
      kind: 'episode',
      tmdbId: 1396,
      title: 'Breaking Bad',
      year: '2008',
      season: 2,
      episode: 5,
      episodeTitle: 'Breakage',
      posterPath: '/poster.jpg',
    },
    {
      kind: 'stream',
      mode: 'scrape',
      name: 'Breaking Bad S02E05',
      url: 'https://cdn.example/v1080/index.m3u8',
      input: 'tt0903747',
      quality: '1080p',
      provider: 'Movy',
      headers: { Referer: 'https://movy.bz/' },
      tiers: [
        { label: '1080p', height: 1080, url: 'https://cdn.example/v1080/index.m3u8', bandwidth: 5_000_000 },
        { label: '720p', height: 720, url: 'https://cdn.example/v720/index.m3u8', bandwidth: 2_500_000 },
      ],
    },
  );
  Object.assign(job, {
    status: 'ready',
    accountId: ACCOUNT.id,
    bunnyVideoId: 'video-1',
    playbackUrl: 'https://vz-x.b-cdn.net/video-1/playlist.m3u8',
    transport: 'tunnel',
    statusCode: 4,
    totalBytes: 1000,
    bytesIn: 1000,
    bytesOut: 1000,
    candidates: [
      {
        provider: 'Movy',
        quality: '1080p',
        url: 'https://cdn.example/v1080/index.m3u8',
        height: 1080,
        type: 'hls',
        headers: { Referer: 'https://movy.bz/' },
        chosen: true,
        note: 'Movy catalogue',
      },
      {
        provider: 'Rigel',
        quality: '720p',
        url: 'https://cdn.example/v720/index.m3u8',
        height: 720,
        type: 'hls',
        headers: { Referer: 'https://movish.to/' },
        note: 'tops out at 720p',
      },
    ],
  });
  return job;
}

function fresh(config: ReturnType<typeof testConfig>): Catalog {
  return new Catalog(config);
}

test('a published job is recorded in full — every source and every quality rung', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  const catalog = fresh(config);

  const entry = catalog.record(readyJob(), ACCOUNT);
  assert.equal(entry.key, 'episode:1396:2:5');
  assert.equal(entry.kind, 'episode');
  assert.equal(entry.title, 'Breaking Bad');
  assert.equal(entry.episodeTitle, 'Breakage');
  assert.equal(entry.year, '2008');

  // where it plays
  assert.equal(entry.videoId, 'video-1');
  assert.equal(entry.playbackUrl, 'https://vz-x.b-cdn.net/video-1/playlist.m3u8');
  assert.equal(entry.accountName, 'primary');
  assert.equal(entry.libraryId, '123456');
  assert.equal(entry.pullZoneHost, 'vz-x.b-cdn.net');
  assert.equal(entry.transport, 'tunnel');
  assert.equal(entry.bunnyStatus, 4);

  // what was published: the chosen tier *and* the ladder it came from
  assert.equal(entry.quality, '1080p');
  assert.equal(entry.provider, 'Movy');
  assert.equal(entry.sourceUrl, 'https://cdn.example/v1080/index.m3u8');
  assert.deepEqual(entry.sourceHeaders, { Referer: 'https://movy.bz/' });
  assert.deepEqual(entry.tiers.map((tier) => tier.label), ['1080p', '720p']);
  assert.equal(entry.tiers[1]?.url, 'https://cdn.example/v720/index.m3u8');

  // every candidate URL, with the headers it needed
  assert.equal(entry.sources.length, 2);
  assert.equal(entry.sources[0]?.chosen, true);
  assert.deepEqual(entry.sources[1]?.headers, { Referer: 'https://movish.to/' });

  // where the job came from, and the sizes
  assert.equal(entry.origin.mode, 'scrape');
  assert.equal(entry.origin.input, 'tt0903747');
  assert.equal(entry.bytes.declared, 1000);
  assert.equal(entry.publishes, 1);
  assert.equal(entry.firstPublishedAt, entry.updatedAt);
});

test('an archive record is attached, and playback follows it only once it is whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  const catalog = fresh(config);
  const entry = catalog.record(readyJob(), ACCOUNT);
  const base: CatalogArchive = {
    bucket: 'archive',
    prefix: 'archive/Shows/Breaking Bad [1396]/Season 02/S02E05 - Breakage',
    objects: [{ name: 'video/1080p.mp4', key: 'archive/…/video/1080p.mp4', kind: 'video', bytes: 10, sha256: 'a'.repeat(64), contentType: 'video/mp4' }],
    manifestKey: 'archive/…/manifest.json',
    bytes: 10,
    videoBytes: 10,
    videos: 1,
    complete: false,
    videoId: 'video-1',
    playbackUrl: 'https://pub-abc.r2.dev/archive/playlist.m3u8',
    removedFromBunny: false,
    at: '2026-02-01T00:00:00.000Z',
  };

  // A half-finished archive must not repoint playback at a folder that is
  // still being filled in.
  catalog.setArchive(entry.key, base);
  const partial = catalog.get(entry.key) as CatalogEntry;
  assert.equal(partial.archive?.complete, false);
  assert.equal(partial.playbackUrl, 'https://vz-x.b-cdn.net/video-1/playlist.m3u8');
  // The search knows which titles have moved: "r2" is a real query.
  assert.equal(catalog.search('r2').length, 1);
  assert.equal(catalog.stats().archived, 1);
  assert.equal(catalog.stats().archivedBytes, 10);

  catalog.setArchive(entry.key, { ...base, complete: true, removedFromBunny: true });
  const whole = catalog.get(entry.key) as CatalogEntry;
  assert.equal(whole.archive?.removedFromBunny, true);
  assert.equal(whole.playbackUrl, 'https://pub-abc.r2.dev/archive/playlist.m3u8');

  // The identity of the entry did not move; only the archive block and the URL.
  assert.equal(whole.videoId, 'video-1');
  assert.equal(whole.publishes, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('publishing the same title again updates its record instead of adding one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  const catalog = fresh(config);

  const first = catalog.record(readyJob(), ACCOUNT);
  const updated = readyJob();
  updated.bunnyVideoId = 'video-2';
  updated.playbackUrl = 'https://vz-x.b-cdn.net/video-2/playlist.m3u8';
  const second = catalog.record(updated, ACCOUNT);

  assert.equal(catalog.size, 1, 'one title is one record');
  assert.equal(second.publishes, 2);
  assert.equal(second.videoId, 'video-2');
  assert.equal(second.firstPublishedAt, first.firstPublishedAt, 'the first publication time is kept');

  // A different episode of the same show is a different record.
  const other = readyJob();
  other.target = { ...other.target, season: 2, episode: 6 };
  catalog.record(other, ACCOUNT);
  assert.equal(catalog.size, 2);
});

test('every catalogue change moves its revision, so a caption landing is visible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  const catalog = fresh(config);

  assert.equal(catalog.revision, 0, 'a fresh catalogue has seen nothing');
  catalog.record(readyJob(), ACCOUNT);
  const recorded = catalog.revision;
  assert.ok(recorded > 0);

  // Reading is not a change.
  catalog.get('episode:1396:2:5');
  catalog.all();
  assert.equal(catalog.revision, recorded);

  // A caption attached to a title that already exists is a change too — this is
  // the one a plain size cannot see.
  catalog.setSubtitles('episode:1396:2:5', [{ srclang: 'ar', label: 'العربية', uploaded: true }]);
  assert.ok(catalog.revision > recorded, 'the backfill landing must be visible to a watcher');

  const afterSubtitles = catalog.revision;
  assert.equal(catalog.remove('episode:1396:2:5'), true);
  assert.ok(catalog.revision > afterSubtitles);
});

test('the catalogue survives a reload and a corrupt file is set aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  fresh(config).record(readyJob(), ACCOUNT);

  const reloaded = fresh(config);
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.get('episode:1396:2:5')?.playbackUrl, 'https://vz-x.b-cdn.net/video-1/playlist.m3u8');

  fs.writeFileSync(path.join(dir, 'catalog.json'), '{not json');
  const afterCorruption = fresh(config);
  assert.equal(afterCorruption.size, 0, 'a corrupt catalogue does not crash the dashboard');
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('catalog.json.corrupt-')));
});

test('search and stats summarise the catalogue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-catalog-'));
  const config = testConfig(dir);
  const catalog = fresh(config);
  catalog.record(readyJob(), ACCOUNT);

  const movieJob = newJob({ kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' }, { kind: 'file', name: 'Inception.mkv', bytes: 4096 });
  Object.assign(movieJob, { status: 'ready', accountId: ACCOUNT.id, bunnyVideoId: 'video-9', playbackUrl: 'https://vz-x.b-cdn.net/video-9/playlist.m3u8' });
  catalog.record(movieJob, ACCOUNT);

  assert.equal(catalog.search('inception').length, 1);
  assert.equal(catalog.search('breaking').length, 1);
  assert.equal(catalog.search('vz-x').length, 2);
  assert.equal(catalog.search('').length, 2);

  const stats = catalog.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.movies, 1);
  assert.equal(stats.episodes, 1);
  assert.equal(stats.publishes, 2);
  // 1000 declared for the scraped episode + 4096 for the uploaded movie.
  assert.equal(stats.bytes, 5096, 'a file job has no declared size, so its uploaded size counts');
  assert.ok(stats.firstPublishedAt && stats.lastPublishedAt);
  assert.equal(typeof stats.byQuality['1080p'], 'number');

  assert.equal(catalog.remove('movie:27205'), true);
  assert.equal(catalog.remove('movie:27205'), false);
  assert.equal(catalog.size, 1);
});
