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
import { ArchiveService, archiveFolder, archiveSlug, captionLanguages, planAssets, playbackRoute } from '../src/archive';
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

/** What a restore did, as the stand-in Bunny recorded it. */
interface RestoreLog {
  created: string[];
  uploads: Array<{ videoId: string; body: Buffer }>;
  captions: Array<{ videoId: string; srclang: string; content: string }>;
  deleted: string[];
}

const RESTORED_VIDEO_ID = 'vid-restored';

/** A Bunny that can also receive an upload, so a restore can be watched. */
function restorableStub(video: BunnyVideo, log: RestoreLog): BunnyClient {
  return {
    getVideo: async (id: string) => ({ ...video, guid: id }),
    deleteVideo: async (id: string) => {
      log.deleted.push(id);
    },
    createVideo: async (title: string) => {
      log.created.push(title);
      return { guid: RESTORED_VIDEO_ID, title, status: 1, encodeProgress: 0, length: 0 };
    },
    uploadVideoResumable: async (videoId: string, filePath: string) => {
      log.uploads.push({ videoId, body: fs.readFileSync(filePath) });
      const size = fs.statSync(filePath).size;
      return { uploadUrl: `mock://tus/${videoId}`, bytesSent: size, totalBytes: size, resumed: false };
    },
    addCaption: async (videoId: string, srclang: string, _label: string, content: string | Buffer) => {
      log.captions.push({ videoId, srclang, content: Buffer.isBuffer(content) ? content.toString('utf8') : content });
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
  /** The account the rig recorded its entry against, pointed at the fake pull zone. */
  account: Account;
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
    /** How long the signed playback URLs this rig mints stay valid. */
    urlTtl?: number;
    /** Small limits make one asset take several part uploads, so progress is observable. */
    r2Options?: { partBytes?: number; singlePutLimitBytes?: number };
    /** A Bunny that also accepts uploads, for a restore. */
    client?: (entry: CatalogEntry) => BunnyClient;
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
      urlTtl: options.urlTtl ?? 300,
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
    ...(options.r2Options ?? {}),
  });
  const archive = new ArchiveService({
    config,
    catalog,
    r2,
    client: options.client ?? (() => bunnyStub(options.video ?? finishedVideo(), deleted)),
    enabled: () => true,
    now: () => NOW,
    retryDelayMs: 5,
  });
  return {
    rig: { dir, config, catalog, entry, account, deleted, archive, r2 },
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
    // Playback moves to the dashboard, which signs a fresh R2 URL per request.
    assert.equal(recorded.playbackUrl, playbackRoute(r.entry.key));
    assert.equal(recorded.archive.mediaKey, `${folder}/video/1080p.mp4`);
    assert.equal(recorded.archive.bunnyPlaybackUrl, `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`);
    // The public folder URL is still recorded, for a bucket served directly.
    assert.equal(recorded.archive.base, R2Client.publicUrl('https://pub-abc.r2.dev', folder));

    assert.equal(r.catalog.stats().archived, 1);
    assert.equal(r.catalog.stats().archivedBytes, recorded.archive.bytes);
  } finally {
    await close();
  }
});

test('without a public base the title plays through the dashboard, not a public bucket', async () => {
  const { rig: r, close } = await rig();
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const recorded = r.catalog.get(r.entry.key);
    // The Bunny URL is kept as a historical note; playback is the dashboard's,
    // so a title Bunny was told to forget still has a link that works.
    assert.equal(recorded?.playbackUrl, playbackRoute(r.entry.key));
    assert.equal(recorded?.archive?.base, undefined);
    assert.equal(recorded?.archive?.bunnyPlaybackUrl, `https://${PULL_ZONE}/${VIDEO_ID}/playlist.m3u8`);
    assert.equal(recorded?.archive?.mediaKey, 'archive/Movies/Inception (2010) [27205]/video/1080p.mp4');
  } finally {
    await close();
  }
});

test('playback hands out a short-lived signed R2 URL for the best rendition', async () => {
  const { rig: r, r2Server, close } = await rig({ urlTtl: 120 });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const entry = r.catalog.get(r.entry.key) as CatalogEntry;
    const media = r.archive.media(entry);
    assert.ok(media, 'an archived title has something to play');
    assert.equal(media.key, 'archive/Movies/Inception (2010) [27205]/video/1080p.mp4');
    assert.equal(media.name, 'video/1080p.mp4');
    assert.equal(media.expiresIn, 120);

    // A real presigned URL: the R2 endpoint, the object key, and a signature.
    const url = new URL(media.url);
    assert.equal(url.origin, r2Server.url);
    assert.equal(decodeURIComponent(url.pathname), '/archive/archive/Movies/Inception (2010) [27205]/video/1080p.mp4');
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(url.searchParams.get('X-Amz-Date'), '20250601T120000Z');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(url.searchParams.get('X-Amz-Credential'), 'key/20250601/auto/s3/aws4_request');
    assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);

    // And it fetches the archived bytes — the stand-in bucket ignores the
    // signature, but a real one verifies exactly this.
    const fetched = await fetch(media.url);
    assert.equal(fetched.status, 200);
    const body = Buffer.from(await fetched.arrayBuffer());
    assert.equal(body.length, 4_096);
    assert.deepEqual(body, r2Server.objects().get(media.key)?.body);

    // Nothing archived means nothing to play, and no public base is needed.
    assert.equal(r.archive.media(undefined), undefined);
    assert.equal(entry.archive?.base, undefined);
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
    // Nothing can be played either: there is no bucket to sign a URL against.
    assert.equal(service.media(entry), undefined);
  } finally {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The queue: background work, task state and live progress             */
/* ------------------------------------------------------------------ */

test('queueing answers before any bytes move, and the title is copied on the queue', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    const report = r.archive.enqueueKeys([r.entry.key], 1);
    assert.equal(report.configured, true);
    assert.equal(report.queued.length, 1);
    assert.equal(report.skipped.length, 0);
    // The call returned with the work still ahead of it: nothing is blocked on
    // a multi-gigabyte download that has not even started.
    assert.equal(r2Server.objects().size, 0);
    assert.equal(r.archive.busy, 1);
    const first = report.queued[0];
    assert.equal(first?.key, r.entry.key);
    assert.equal(first?.title, 'Inception (2010)');

    await r.archive.idle(5_000);
    // Every asset the pull zone had, plus the manifest written last.
    assert.equal(r2Server.objects().size, 14);
    const task = r.archive.task(r.entry.key);
    assert.equal(task?.status, 'done');
    assert.equal(task?.percent, 100);
    assert.equal(r.archive.busy, 0);
    // A second title waits its turn rather than opening a second download.
    assert.equal(r.archive.enqueueKeys([r.entry.key], 1).skipped[0]?.reason, 'nothing left to archive');
  } finally {
    await close();
  }
});

test('a task walks its stages in order and reports its bytes as they move', async () => {
  // Small limits force one 4 KiB rendition to take several part uploads, which
  // is what makes progress observable inside a single file.
  const { rig: r, close } = await rig({ r2Options: { partBytes: 1_024, singlePutLimitBytes: 2_048 } });
  const stages: string[] = [];
  const percents: number[] = [];
  const byteViews: number[] = [];
  const assetsSeen = new Set<string>();
  const stop = r.archive.onTaskChange((task) => {
    if (task.key !== r.entry.key) return;
    if (stages[stages.length - 1] !== task.stage) stages.push(task.stage);
    percents.push(task.percent);
    byteViews.push(task.bytes);
    if (task.asset) assetsSeen.add(task.asset);
  });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);

    assert.ok(stages.includes('checking'), `stages: ${stages.join(' → ')}`);
    assert.ok(stages.includes('scanning'), `stages: ${stages.join(' → ')}`);
    assert.ok(stages.includes('uploading'), `stages: ${stages.join(' → ')}`);
    assert.ok(stages.indexOf('manifest') < stages.indexOf('deleting'), `the index is written before Bunny lets go: ${stages.join(' → ')}`);
    assert.equal(stages[stages.length - 1], 'done');

    // The bar only ever moves forwards, and it reaches the end.
    for (let index = 1; index < percents.length; index += 1) {
      assert.ok((percents[index] ?? 0) >= (percents[index - 1] ?? 0), `progress went backwards at ${index}: ${percents.join(',')}`);
    }
    assert.equal(percents.at(-1), 100);

    const task = r.archive.task(r.entry.key);
    assert.ok(task);
    assert.ok(task.totalBytes > 0, 'the scan measured the job');
    assert.equal(task.bytes, task.totalBytes, 'every measured byte was handed to R2');
    assert.equal(task.assets, 13, 'every asset the pull zone had, minus the manifest');
    assert.equal(task.stored, 13);
    assert.equal(task.removedFromBunny, true);
    // Progress inside one file, not just between files.
    assert.ok(
      byteViews.some((bytes) => bytes > 0 && bytes < task.totalBytes),
      `expected a mid-file reading, saw ${byteViews.slice(0, 6).join(',')} …`,
    );
    assert.ok(assetsSeen.has('video/1080p.mp4'), `assets seen: ${[...assetsSeen].join(', ')}`);
    assert.ok(assetsSeen.has('manifest.json'));
  } finally {
    stop();
    await close();
  }
});

test('a title waiting its turn says where it is in line', async () => {
  const { rig: r, close } = await rig({ episode: true });
  try {
    // A second title on the same account, so both come off the same pull zone.
    r.catalog.record(readyMovie(), r.account);
    const keys = r.catalog.all().map((entry) => entry.key);
    assert.equal(keys.length, 2);
    const report = r.archive.enqueueKeys(keys, 2);
    assert.equal(report.queued.length, 2);
    assert.equal(r.archive.busy, 2);
    // One is already moving; the other is queued, first in line, and says so.
    const sorted = [...report.queued].sort((a, b) => (a.status === 'queued' ? 1 : 0) - (b.status === 'queued' ? 1 : 0));
    assert.equal(sorted[0]?.status, 'active');
    assert.equal(sorted[1]?.status, 'queued');
    assert.equal(sorted[1]?.position, 1);
    await r.archive.idle(10_000);
    assert.equal(r.archive.busy, 0);
    for (const key of keys) assert.equal(r.archive.task(key)?.status, 'done', `${key} finished`);
  } finally {
    await close();
  }
});

test('a refused upload ends the task, and a queued one comes back round', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    r2Server.failPuts(100, 403);

    // Queued by hand: the operator is watching, so the reason is reported now
    // rather than after a retry five minutes away.
    r.archive.enqueueKeys([r.entry.key], 1);
    await r.archive.idle(5_000);
    const failed = r.archive.task(r.entry.key);
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error ?? '', /403/);
    assert.equal(failed?.attempts, 1);
    assert.equal(r.archive.busy, 0);
    assert.deepEqual(r.deleted, [], 'Bunny still has the video');

    // Queued by a publish: it is retried, and only gives up after the budget.
    const entry = r.catalog.get(r.entry.key) as CatalogEntry;
    assert.equal(r.archive.consider(entry), true);
    await r.archive.idle(5_000);
    const retried = r.archive.task(r.entry.key);
    assert.equal(retried?.status, 'failed');
    assert.equal(retried?.attempts, 3, 'the automatic path used its whole budget');
  } finally {
    await close();
  }
});

test('a task listener that throws cannot break an archive', async () => {
  const { rig: r, r2Server, close } = await rig();
  const originalError = console.error;
  console.error = () => {};
  try {
    const stop = r.archive.onTaskChange(() => {
      throw new Error('listener exploded');
    });
    r.archive.enqueueKeys([r.entry.key], 1);
    await r.archive.idle(5_000);
    stop();
    assert.equal(r.archive.task(r.entry.key)?.status, 'done');
    assert.ok(r2Server.objects().has('archive/Movies/Inception (2010) [27205]/manifest.json'));
  } finally {
    console.error = originalError;
    await close();
  }
});

/* ------------------------------------------------------------------ */
/* Verifying an archive that already exists in the bucket              */
/* ------------------------------------------------------------------ */

test('a verification pass re-reads the manifest and re-hashes every object', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const readsBefore = r2Server.transcript.gets;

    const report = r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    assert.equal(report.queued.length, 1);
    assert.equal(report.queued[0]?.operation, 'verify');
    // Queued, not done: the check runs on the queue like everything else.
    assert.ok(['queued', 'active'].includes(r.archive.task(r.entry.key)?.status ?? ''), 'the check did not run inside the request');
    await r.archive.idle(5_000);

    const task = r.archive.task(r.entry.key);
    assert.equal(task?.operation, 'verify');
    assert.equal(task?.status, 'done');
    assert.equal(task?.percent, 100);
    // The manifest's own list is the index: 13 assets were re-read, plus the manifest.
    assert.equal(task?.checked, 13);
    assert.deepEqual(task?.bad, []);
    assert.ok(
      r2Server.transcript.gets - readsBefore >= 14,
      `the objects were read back, not just HEAD-ed (${r2Server.transcript.gets - readsBefore} read(s))`,
    );

    const recorded = r.catalog.get(r.entry.key);
    assert.equal(recorded?.archive?.verify?.ok, true);
    assert.equal(recorded?.archive?.verify?.checked, 13);
    assert.deepEqual(recorded?.archive?.verify?.missing, []);
    assert.deepEqual(recorded?.archive?.verify?.mismatched, []);
    assert.equal(recorded?.archive?.verifiedAt, NOW.toISOString());
    // Nothing about where it plays moved — a check only reads.
    assert.equal(recorded?.archive?.removedFromBunny, true);
    assert.equal(r.archive.verifyCandidates()[0]?.verified, true);
  } finally {
    await close();
  }
});

test('a verification pass names the object whose bytes no longer match', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const folder = 'archive/Movies/Inception (2010) [27205]';
    assert.equal(r2Server.tamper(`${folder}/video/720p.mp4`, Buffer.alloc(1_111, 0x42)), true);

    r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    await r.archive.idle(5_000);

    const task = r.archive.task(r.entry.key);
    assert.equal(task?.status, 'failed');
    assert.deepEqual(task?.bad, ['video/720p.mp4']);
    assert.match(task?.note ?? '', /changed/);
    assert.equal(r.archive.busy, 0);

    const recorded = r.catalog.get(r.entry.key);
    assert.equal(recorded?.archive?.verify?.ok, false);
    assert.deepEqual(recorded?.archive?.verify?.mismatched, ['video/720p.mp4']);
    assert.deepEqual(recorded?.archive?.verify?.missing, []);
    // The stored object is left exactly as it was found — a check does not "fix".
    assert.equal(r2Server.objects().get(`${folder}/video/720p.mp4`)?.body.length, 1_111);
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------------ */
/* Mending the objects a check flagged                                 */
/* ------------------------------------------------------------------ */

test('a repair re-copies just the flagged object from Bunny and puts it back', async () => {
  // Bunny keeps its copy, which is the only place the original bytes can come
  // from once the one in the bucket has rotted.
  const { rig: r, r2Server, pull, close } = await rig({ keepBunny: true });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const folder = 'archive/Movies/Inception (2010) [27205]';
    const target = `${folder}/video/720p.mp4`;
    const original = r2Server.objects().get(target)?.body as Buffer;
    assert.equal(r2Server.tamper(target, Buffer.alloc(1_111, 0x42)), true);

    r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    await r.archive.idle(5_000);
    assert.deepEqual(r.archive.task(r.entry.key)?.bad, ['video/720p.mp4']);

    // A repair is only offered because the check named something.
    assert.equal(r.archive.repairEligible(r.catalog.get(r.entry.key) as CatalogEntry), true);
    const readsBefore = pull.transcript.gets;
    const report = r.archive.enqueueKeys([r.entry.key], 1, 'repair');
    assert.equal(report.queued.length, 1);
    assert.equal(report.queued[0]?.operation, 'repair');
    await r.archive.idle(10_000);

    const task = r.archive.task(r.entry.key);
    assert.equal(task?.status, 'done', task?.note ?? '');
    assert.deepEqual(task?.repaired, ['video/720p.mp4']);
    assert.deepEqual(task?.dropped, []);
    // Exactly one object was re-fetched, not the whole title.
    assert.equal(pull.transcript.gets - readsBefore, 1);

    // The stored bytes are the original ones again, and the record says so.
    assert.deepEqual(r2Server.objects().get(target)?.body, original);
    const recorded = r.catalog.get(r.entry.key);
    assert.deepEqual(recorded?.archive?.repair?.recopied, ['video/720p.mp4']);
    assert.deepEqual(recorded?.archive?.repair?.dropped, []);
    assert.equal(recorded?.archive?.repair?.at, NOW.toISOString());
    assert.equal(recorded?.archive?.repairedAt, NOW.toISOString());
    // The repair ends by verifying the folder, so the stale verdict is replaced.
    assert.equal(recorded?.archive?.verify?.ok, true);
    assert.deepEqual(recorded?.archive?.verify?.mismatched, []);
    assert.equal(recorded?.archive?.objects.length, 13);
    assert.equal(r.archive.repairEligible(recorded as CatalogEntry), false, 'a mended title stops offering a repair');
  } finally {
    await close();
  }
});

test('with Bunny gone, a repair keeps the title playable from an intact neighbour', async () => {
  const deleted: string[] = [];
  let bunnyAlive = true;
  const client = {
    getVideo: async (id: string) => {
      if (!bunnyAlive) throw new Error('Bunny request failed (404)');
      return { ...finishedVideo(), guid: id };
    },
    deleteVideo: async (id: string) => {
      deleted.push(id);
    },
  } as unknown as BunnyClient;

  const { rig: r, r2Server, close } = await rig({ client: () => client });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const folder = 'archive/Movies/Inception (2010) [27205]';
    // The tall rendition rots, and Bunny has let the video go.
    r2Server.tamper(`${folder}/video/1080p.mp4`, Buffer.from('rot'));
    bunnyAlive = false;

    r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    await r.archive.idle(5_000);
    assert.deepEqual(r.archive.task(r.entry.key)?.bad, ['video/1080p.mp4']);

    r.archive.enqueueKeys([r.entry.key], 1, 'repair');
    await r.archive.idle(10_000);

    const task = r.archive.task(r.entry.key);
    assert.equal(task?.status, 'done', task?.note ?? '');
    assert.deepEqual(task?.repaired, []);
    assert.deepEqual(task?.dropped, ['video/1080p.mp4']);

    const recorded = r.catalog.get(r.entry.key);
    // Nothing could supply the lost bytes, so it is gone from the record — and
    // playback moved onto the intact neighbour rather than a hole.
    assert.deepEqual(recorded?.archive?.repair?.dropped, ['video/1080p.mp4']);
    assert.equal(recorded?.archive?.repair?.switchedTo, 'video/720p.mp4');
    assert.equal(recorded?.archive?.mediaKey, `${folder}/video/720p.mp4`);
    assert.equal(recorded?.archive?.objects.some((object) => object.name === 'video/1080p.mp4'), false);
    assert.equal(recorded?.archive?.videos, 2);
    assert.equal(recorded?.archive?.videoBytes, 2_048 + 1_024);
    assert.equal(recorded?.archive?.complete, false, 'a folder missing an object is no longer whole');
    assert.equal(recorded?.archive?.verify?.ok, true, 'what is left verifies');

    // The manifest was rewritten to match the bucket, so the folder agrees with
    // its own index again and a later check has nothing to complain about.
    const manifest = JSON.parse(r2Server.objects().get(`${folder}/manifest.json`)?.body.toString('utf8') ?? '{}') as {
      objects: Array<{ name: string }>;
      videos: number;
      repairedAt: string | null;
    };
    assert.equal(manifest.objects.some((object) => object.name === 'video/1080p.mp4'), false);
    assert.equal(manifest.videos, 2);
    assert.equal(manifest.repairedAt, NOW.toISOString());

    // And the title still plays, from the surviving rendition.
    const media = r.archive.media(recorded as CatalogEntry);
    assert.equal(media?.key, `${folder}/video/720p.mp4`);
    assert.equal(r.archive.repairEligible(recorded as CatalogEntry), false);
  } finally {
    await close();
  }
});

test('a repair is offered only once a check has actually failed', async () => {
  const { rig: r, r2Server, close } = await rig();
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const entry = () => r.catalog.get(r.entry.key) as CatalogEntry;
    // Archived but never checked: there is nothing named to mend.
    assert.equal(r.archive.repairEligible(entry()), false);
    assert.match(r.archive.enqueueKeys([r.entry.key], 1, 'repair').skipped[0]?.reason ?? '', /found nothing to mend/);

    // A check that passes leaves nothing to mend either.
    r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    await r.archive.idle(5_000);
    assert.equal(r.archive.repairEligible(entry()), false);

    // Only a failing check opens the door, and it names the work list.
    const folder = 'archive/Movies/Inception (2010) [27205]';
    r2Server.tamper(`${folder}/images/thumbnail.jpg`, Buffer.from('rot'));
    r.archive.enqueueKeys([r.entry.key], 1, 'verify');
    await r.archive.idle(5_000);
    assert.equal(r.archive.repairEligible(entry()), true);
    const candidate = r.archive.repairCandidates()[0];
    assert.equal(candidate?.key, r.entry.key);
    assert.equal(candidate?.objects, 1);
    assert.equal(candidate?.fromBunny, false, 'the archive removed the video, so Bunny has nothing to re-fetch from');
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------------ */
/* Putting an archived title back into Bunny                           */
/* ------------------------------------------------------------------ */

test('a restore streams the archived rendition back into Bunny, captions included', async () => {
  const log: RestoreLog = { created: [], uploads: [], captions: [], deleted: [] };
  const { rig: r, r2Server, close } = await rig({ client: () => restorableStub(finishedVideo(), log) });
  try {
    await r.archive.archiveKeys([r.entry.key], 1);
    const folder = 'archive/Movies/Inception (2010) [27205]';
    const archived = r2Server.objects().get(`${folder}/video/1080p.mp4`)?.body;
    assert.ok(archived, 'the tallest rendition was archived');
    // The archive run told Bunny to forget the original video.
    assert.deepEqual(log.deleted, [VIDEO_ID]);

    const report = r.archive.enqueueKeys([r.entry.key], 1, 'restore');
    assert.equal(report.queued.length, 1);
    assert.equal(report.queued[0]?.operation, 'restore');
    await r.archive.idle(10_000);

    const task = r.archive.task(r.entry.key);
    assert.equal(task?.status, 'done');
    assert.equal(task?.percent, 100);
    assert.equal(task?.restoredVideoId, RESTORED_VIDEO_ID);

    // A fresh video was made and the tallest rendition went into it, byte for byte.
    assert.deepEqual(log.created, ['Inception (2010)']);
    assert.equal(log.uploads.length, 1);
    assert.equal(log.uploads[0]?.videoId, RESTORED_VIDEO_ID);
    assert.deepEqual(log.uploads[0]?.body, archived);

    // And the caption came back with it.
    assert.deepEqual(log.captions.map((caption) => caption.srclang), ['en']);
    assert.match(log.captions[0]?.content ?? '', /WEBVTT/);

    const recorded = r.catalog.get(r.entry.key);
    assert.equal(recorded?.videoId, RESTORED_VIDEO_ID);
    assert.equal(recorded?.playbackUrl, `${r.account.pullZoneHost}/${RESTORED_VIDEO_ID}/playlist.m3u8`);
    assert.equal(recorded?.archive?.restoredVideoId, RESTORED_VIDEO_ID);
    assert.equal(recorded?.archive?.restoredAt, NOW.toISOString());
    // A restore is a copy, not a move: the archive is still in the bucket.
    assert.ok(r2Server.objects().has(`${folder}/manifest.json`));
    // The restored video is a new one, so the title is archivable again.
    assert.equal(r.archive.eligible(r.catalog.get(r.entry.key) as CatalogEntry), true);
  } finally {
    await close();
  }
});

test('a title whose archive holds no rendition is not offered for restore', async () => {
  const { rig: r, close } = await rig();
  try {
    const entry = r.catalog.get(r.entry.key) as CatalogEntry;
    r.catalog.setArchive(entry.key, {
      bucket: 'archive',
      prefix: 'archive/odds-and-ends',
      objects: [{ name: 'images/thumbnail.jpg', key: 'archive/odds-and-ends/images/thumbnail.jpg', kind: 'thumbnail', bytes: 10, sha256: 'x', contentType: 'image/jpeg' }],
      manifestKey: 'archive/odds-and-ends/manifest.json',
      bytes: 10,
      videoBytes: 0,
      videos: 0,
      complete: false,
      videoId: VIDEO_ID,
      removedFromBunny: false,
      at: NOW.toISOString(),
    });
    const updated = r.catalog.get(entry.key) as CatalogEntry;
    assert.equal(r.archive.restoreEligible(updated), false);
    const report = r.archive.enqueueKeys([entry.key], 1, 'restore');
    assert.equal(report.queued.length, 0);
    assert.match(report.skipped[0]?.reason ?? '', /nothing in R2 can be put back/);
  } finally {
    await close();
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
