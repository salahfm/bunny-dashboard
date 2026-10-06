/**
 * The archive, driven end to end against a fake pull zone and a fake R2 bucket.
 *
 * These are the assertions that matter for the promise "copy everything, then
 * remove it from Bunny": every rendition and still lands under the same tidy
 * folder, the manifest is written last and indexes all of it, the video is
 * deleted only after the copy verified, and a run that could not copy the video
 * leaves Bunny untouched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchiveService, archiveFolder, archiveSlug, captionLanguages, planAssets } from '../src/archive';
import type { BunnyClient, BunnyVideo } from '../src/bunny';
import { Catalog, type CatalogEntry } from '../src/catalog';
import type { AppConfig } from '../src/config';
import { R2Client } from '../src/r2';
import { newJob, type Account, type Job, type JobTarget } from '../src/store';
import { testConfig } from './helpers';
import { startFakePullZone, type FakePullZoneFile } from './support/fake-pullzone';
import { startFakeR2 } from './support/fake-r2';

const VIDEO_ID = 'vid-abc';
const PULL_ZONE = 'cdn.example.b-cdn.net';
const NOW = new Date('2025-06-01T12:00:00Z');

const ACCOUNT: Account = {
  id: 'acc-1',
  name: 'primary',
  libraryId: '123456',
  apiKeyEnc: 'enc',
  pullZoneHost: PULL_ZONE,
  enabled: true,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

/**
 * The same account, pointed at the stand-in pull zone the test started. The
 * full `http://127.0.0.1:<port>` URL is kept: a bare host would be read as an
 * https hostname and the plain-HTTP stand-in would be spoken to over TLS.
 */
function accountAt(url: string): Account {
  return { ...ACCOUNT, pullZoneHost: url };
}

function readyMovie(): Job {
  const target: JobTarget = { kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' };
  return Object.assign(newJob(target, { kind: 'stream', mode: 'scrape', name: 'inception.mkv' }), {
    status: 'ready',
    accountId: ACCOUNT.id,
    bunnyVideoId: VIDEO_ID,
    playbackUrl: `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`,
    statusCode: 4,
  });
}

function readyEpisode(): Job {
  const target: JobTarget = {
    kind: 'episode',
    tmdbId: 1396,
    title: 'Breaking Bad',
    year: '2008',
    season: 2,
    episode: 5,
    episodeTitle: 'Breakage',
  };
  return Object.assign(newJob(target, { kind: 'stream', mode: 'scrape', name: 'bb.s02e05.mkv' }), {
    status: 'ready',
    accountId: ACCOUNT.id,
    bunnyVideoId: VIDEO_ID,
    playbackUrl: `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`,
    statusCode: 4,
  });
}

function finishedVideo(overrides: Partial<BunnyVideo> = {}): BunnyVideo {
  return {
    guid: VIDEO_ID,
    title: 'tmdb:27205',
    status: 4,
    encodeProgress: 100,
    length: 5_400,
    availableResolutions: '1080p,720p,480p',
    captions: [{ srclang: 'en', label: 'English' }],
    ...overrides,
  };
}

function bunnyStub(video: BunnyVideo, deleted: string[]): BunnyClient {
  return {
    getVideo: async (id: string) => ({ ...video, guid: id }),
    deleteVideo: async (id: string) => {
      deleted.push(id);
    },
  } as unknown as BunnyClient;
}

/** The pull zone a finished 1080p/720p/480p video would expose. */
function pullZoneFiles(): Record<string, FakePullZoneFile> {
  const mp4 = (bytes: number) => Buffer.alloc(bytes, 0x41);
  return {
    [`${VIDEO_ID}/play_1080p.mp4`]: { body: mp4(4_096), contentType: 'video/mp4' },
    [`${VIDEO_ID}/play_720p.mp4`]: { body: mp4(2_048), contentType: 'video/mp4' },
    [`${VIDEO_ID}/play_480p.mp4`]: { body: mp4(1_024), contentType: 'video/mp4' },
    [`${VIDEO_ID}/playlist.m3u8`]: { body: '#EXTM3U\n', contentType: 'application/vnd.apple.mpegurl' },
    [`${VIDEO_ID}/thumbnail.jpg`]: { body: 'jpeg-bytes', contentType: 'image/jpeg' },
    [`${VIDEO_ID}/thumbnail_1.jpg`]: { body: 'jpeg-bytes-1', contentType: 'image/jpeg' },
    [`${VIDEO_ID}/preview.gif`]: { body: 'gif-bytes', contentType: 'image/gif' },
    [`${VIDEO_ID}/preview.webp`]: { body: 'webp-bytes', contentType: 'image/webp' },
    [`${VIDEO_ID}/preview_hq.mp4`]: { body: mp4(64), contentType: 'video/mp4' },
    [`${VIDEO_ID}/preview_hq.webm`]: { body: 'webm-bytes', contentType: 'video/webm' },
    [`${VIDEO_ID}/seek/_0.jpg`]: { body: 'sprite-0', contentType: 'image/jpeg' },
    [`${VIDEO_ID}/seek/_1.jpg`]: { body: 'sprite-1', contentType: 'image/jpeg' },
    [`${VIDEO_ID}/captions/en.vtt`]: { body: 'WEBVTT\n\n00:00.000 --> 00:02.000\nHi\n', contentType: 'text/vtt' },
  };
}

interface Rig {
  dir: string;
  config: AppConfig;
  catalog: Catalog;
  entry: CatalogEntry;
  deleted: string[];
  archive: ArchiveService;
  r2: R2Client;
}

async function rig(
  options: {
    files?: Record<string, FakePullZoneFile>;
    video?: BunnyVideo;
    episode?: boolean;
    keepBunny?: boolean;
    publicBase?: string;
  } = {},
): Promise<{ rig: Rig; r2Server: Awaited<ReturnType<typeof startFakeR2>>; pull: Awaited<ReturnType<typeof startFakePullZone>>; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-archive-'));
  const r2Server = await startFakeR2('archive');
  const pull = await startFakePullZone(options.files ?? pullZoneFiles());
  const config = testConfig(dir, {
    r2: {
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'archive',
      endpoint: r2Server.url,
      ...(options.publicBase ? { publicBase: options.publicBase } : {}),
      prefix: 'archive',
      enabled: true,
      keepBunny: options.keepBunny ?? false,
    },
  });
  const catalog = new Catalog(config);
  const job = options.episode ? readyEpisode() : readyMovie();
  const account = accountAt(pull.url);
  const entry = catalog.record(job, account);
  const deleted: string[] = [];
  const r2 = new R2Client({
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'archive',
    endpoint: r2Server.url,
    now: () => NOW,
  });
  const archive = new ArchiveService({
    config,
    catalog,
    r2,
    client: () => bunnyStub(options.video ?? finishedVideo(), deleted),
    enabled: () => true,
    now: () => NOW,
    retryDelayMs: 5,
  });
  return {
    rig: { dir, config, catalog, entry, deleted, archive, r2 },
    r2Server,
    pull,
    close: async () => {
      archive.stop();
      await r2Server.close();
      await pull.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a finished movie is copied whole into R2, then removed from Bunny', async () => {
  const { rig: r, r2Server, close } = await rig({ publicBase: 'https://pub-abc.r2.dev' });
  try {
    const report = await r.archive.archiveKeys([r.entry.key], 1);
    assert.equal(report.configured, true);
    assert.match(report.results[0] ?? '', /archived$/);

    const stored = r2Server.objects();
    const folder = 'archive/Movies/Inception (2010) [27205]';
    const expected = [
      `${folder}/video/1080p.mp4`,
      `${folder}/video/720p.mp4`,
      `${folder}/video/480p.mp4`,
      `${folder}/hls/playlist.m3u8`,
      `${folder}/images/thumbnail.jpg`,
      `${folder}/images/thumbnail_1.jpg`,
      `${folder}/images/preview.gif`,
      `${folder}/images/preview.webp`,
      `${folder}/images/preview_hq.mp4`,
      `${folder}/images/preview_hq.webm`,
      `${folder}/sprites/seek_0.jpg`,
      `${folder}/sprites/seek_1.jpg`,
      `${folder}/subtitles/en.vtt`,
      `${folder}/manifest.json`,
    ];
    for (const key of expected) assert.ok(stored.has(key), `missing ${key}`);
    assert.deepEqual([...stored.keys()].sort(), [...expected].sort());

    // Every rendition is byte-for-byte the pull zone's file.
    assert.equal(stored.get(`${folder}/video/1080p.mp4`)?.body.length, 4_096);
    assert.equal(stored.get(`${folder}/video/720p.mp4`)?.body.length, 2_048);
    assert.equal(stored.get(`${folder}/video/480p.mp4`)?.body.length, 1_024);

    // The assets Bunny did not generate were skipped, not invented.
    assert.equal(stored.has(`${folder}/images/thumbnail_2.jpg`), false);
    assert.equal(stored.has(`${folder}/original`), false);
    assert.equal(stored.has(`${folder}/sprites/seek_2.jpg`), false);

    // The manifest indexes everything and is written last.
    const manifest = JSON.parse(stored.get(`${folder}/manifest.json`)?.body.toString('utf8') ?? '{}') as {
      key: string;
      bucket: string;
      videos: number;
      objects: Array<{ key: string; sha256: string }>;
      bunny: { videoId: string };
    };
    assert.equal(manifest.key, r.entry.key);
    assert.equal(manifest.bucket, 'archive');
    assert.equal(manifest.videos, 3);
    assert.equal(manifest.bunny.videoId, VIDEO_ID);
    assert.equal(manifest.objects.length, expected.length - 1);
    for (const object of manifest.objects) assert.match(object.sha256, /^[0-9a-f]{64}$/);

    // And only now was Bunny told to forget the video.
    assert.deepEqual(r.deleted, [VIDEO_ID]);

    const recorded = r.catalog.get(r.entry.key);
    if (!recorded?.archive) throw new Error('the archive was not recorded on the catalogue');
    assert.equal(recorded.archive.complete, true);
    assert.equal(recorded.archive.removedFromBunny, true);
    assert.equal(recorded.archive.videos, 3);
    assert.equal(recorded.archive.videoBytes, 4_096 + 2_048 + 1_024);
    assert.equal(recorded.archive.objects.length, expected.length - 1);
    assert.equal(recorded.archive.manifestKey, `${folder}/manifest.json`);
    // Playback follows the archive, because the bucket has a public base.
    assert.equal(recorded.playbackUrl, R2Client.publicUrl('https://pub-abc.r2.dev', `${folder}/hls/playlist.m3u8`));
    assert.equal(recorded.archive.bunnyPlaybackUrl, `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`);

    assert.equal(r.catalog.stats().archived, 1);
    assert.equal(r.catalog.stats().archivedBytes, recorded.archive.bytes);
  } finally {
    await close();
  }
});

test('without a public base the Bunny playback URL is left alone', async () => {
  const { rig: r, close } = await rig();
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const recorded = r.catalog.get(r.entry.key);
    assert.equal(recorded?.playbackUrl, `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`);
    assert.equal(recorded?.archive?.playbackUrl, undefined);
    assert.equal(recorded?.archive?.base, undefined);
  } finally {
    await close();
  }
});

test('an episode is filed under its show, season and episode', async () => {
  const { rig: r, r2Server, close } = await rig({ episode: true });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const folder = 'archive/Shows/Breaking Bad [1396]/Season 02/S02E05 - Breakage';
    for (const suffix of ['video/1080p.mp4', 'images/preview.gif', 'subtitles/en.vtt', 'manifest.json']) {
      assert.ok(r2Server.objects().has(`${folder}/${suffix}`), `missing ${folder}/${suffix}`);
    }
  } finally {
    await close();
  }
});

test('a video with no MP4 rendition keeps Bunny holding it', async () => {
  const files = pullZoneFiles();
  for (const key of Object.keys(files)) if (key.includes('play_')) delete files[key];
  const { rig: r, close } = await rig({ files });
  try {
    const report = await r.archive.archiveKeys([r.entry.key], 1);
    assert.match(report.results[0] ?? '', /^movie:27205: skipped/);
    assert.deepEqual(r.deleted, [], 'Bunny must keep the only copy of the video');
    const recorded = r.catalog.get(r.entry.key);
    assert.equal(recorded?.archive?.complete, false);
    assert.match(recorded?.archive?.note ?? '', /MP4 Fallback/);
    // The stills were still archived — only the deletion was withheld.
    assert.ok((recorded?.archive?.objects.length ?? 0) > 0);
  } finally {
    await close();
  }
});

test('an upload that fails leaves Bunny exactly as it was', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    r2Server.failPuts(100, 403);
    const report = await r.archive.archiveKeys([r.entry.key], 1);
    assert.match(report.results[0] ?? '', /partial/);
    assert.deepEqual(r.deleted, [], 'a failed copy must not delete the video');
    assert.equal(r.catalog.get(r.entry.key)?.archive, undefined);
    assert.equal(r2Server.objects().size, 0);
  } finally {
    await close();
  }
});

test('consider() archives the title a publish just wrote, after the subtitle repair', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    const order: string[] = [];
    const service = new ArchiveService({
      config: r.config,
      catalog: r.catalog,
      r2: r.r2,
      client: () => bunnyStub(finishedVideo(), r.deleted),
      enabled: () => true,
      before: async () => {
        order.push('waited');
      },
      now: () => NOW,
      retryDelayMs: 5,
    });
    try {
      assert.equal(service.consider(r.catalog.get(r.entry.key) as CatalogEntry), true);
      await service.idle(5_000);
      assert.deepEqual(order, ['waited'], 'the archive waited for whatever was still working on the title');
      assert.deepEqual(r.deleted, [VIDEO_ID]);
      assert.ok(r2Server.objects().has('archive/Movies/Inception (2010) [27205]/manifest.json'));
      // Archived already, so a second publish of the same video is not queued.
      assert.equal(service.consider(r.catalog.get(r.entry.key) as CatalogEntry), false);
    } finally {
      service.stop();
    }
  } finally {
    await close();
  }
});

test('the archive is never attempted when no destination is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-archive-'));
  const config = testConfig(dir);
  const catalog = new Catalog(config);
  const entry = catalog.record(readyMovie(), ACCOUNT);
  const service = new ArchiveService({ config, catalog, client: () => undefined, enabled: () => true });
  try {
    assert.equal(service.configured, false);
    assert.equal(service.enabled(), false);
    assert.equal(service.consider(entry), false);
    assert.deepEqual((await service.archiveKeys([entry.key], 1)).results, []);
    assert.equal(catalog.get(entry.key)?.archive, undefined);
  } finally {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The layout and the plan                                             */
/* ------------------------------------------------------------------ */

test('the folder layout is readable, and ids keep it collision-free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-archive-'));
  try {
    const catalog = new Catalog(testConfig(dir));
    const movie = catalog.record(readyMovie(), ACCOUNT);
    assert.equal(archiveFolder('archive', movie), 'archive/Movies/Inception (2010) [27205]');
    const episode = catalog.record(readyEpisode(), ACCOUNT);
    assert.equal(archiveFolder('archive', episode), 'archive/Shows/Breaking Bad [1396]/Season 02/S02E05 - Breakage');
    // A title that is only punctuation still gets a folder, and unknown names
    // fall back to the id rather than to nothing.
    assert.equal(archiveSlug('///', 'fallback'), 'fallback');
    assert.equal(archiveSlug('A/B: C?', 'x'), 'A B C');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the plan lists every rendition and preview, and the captions Bunny holds', () => {
  const video = finishedVideo({ availableResolutions: '2160p,1080p,720p' });
  const planned = planAssets(video, 'https://cdn.example', ['en', 'ar']);
  const names = planned.map((asset) => asset.name);
  // 2160p is dropped: the MP4 fallbacks stop at 1080p.
  assert.deepEqual(names.slice(0, 2), ['video/1080p.mp4', 'video/720p.mp4']);
  assert.ok(names.includes('images/preview.webp'));
  assert.ok(names.includes('images/thumbnail_1.jpg'));
  assert.ok(names.includes('subtitles/en.vtt'));
  assert.ok(names.includes('subtitles/ar.vtt'));
  assert.equal(names.includes('video/2160p.mp4'), false);
  assert.equal(planned.find((asset) => asset.name === 'subtitles/en.vtt')?.url, `https://cdn.example/${VIDEO_ID}/captions/en.vtt`);
});

test('a missing resolution list still plans the usual ladder, to be probed', () => {
  const planned = planAssets(finishedVideo({ availableResolutions: undefined }), 'https://cdn.example', []);
  assert.deepEqual(planned.filter((asset) => asset.kind === 'video').map((asset) => asset.name), [
    'video/1080p.mp4',
    'video/720p.mp4',
    'video/480p.mp4',
    'video/360p.mp4',
    'video/240p.mp4',
  ]);
});

test('captions come from the catalogue and from what Bunny still reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-archive-'));
  try {
    const catalog = new Catalog(testConfig(dir));
    const entry = catalog.record(readyMovie(), ACCOUNT);
    catalog.setSubtitles(entry.key, [{ srclang: 'EN', label: 'English', uploaded: true }]);
    const languages = captionLanguages(catalog.get(entry.key) as CatalogEntry, finishedVideo({ captions: [{ srclang: 'ar', label: 'Arabic' }] }));
    assert.deepEqual(languages, ['ar', 'en']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
