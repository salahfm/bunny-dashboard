/**
 * The subtitle backfill, over real HTTP.
 *
 * A tiny origin serves the subtitle file and the master playlist the catalogue
 * recorded, and a tiny stand-in for DeepL answers the translation. That way the
 * test proves the whole point of the feature: a title that is already published
 * gets its target-language caption from the *recorded* text, without anything
 * being downloaded or published a second time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SubtitleAutoRepair, SubtitleBackfill, hasSubtitle, pivotTrack, readablePivot, repairable } from '../src/backfill';
import type { BackfillOutcome, BackfillReport } from '../src/backfill';
import { Catalog, type CatalogEntry } from '../src/catalog';
import type { BunnyClient } from '../src/bunny';
import { newJob, type Job, type JobCandidate, type JobSource, type JobTarget, type SubtitleTrack } from '../src/store';
import { testConfig, waitFor } from './helpers';

const ENGLISH_VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:03.000',
  'Hello there',
  '',
  '00:00:04.000 --> 00:00:06.000',
  'Second line',
  '',
].join('\n');

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.vtt"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,SUBTITLES="subs"',
  'v1080/index.m3u8',
  '',
].join('\n');

/** A cue file for one title, whose lines name it, so a batch's reads can be told apart. */
function titledVtt(name: string): string {
  return [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    `Hello from ${name}`,
    '',
    '00:00:04.000 --> 00:00:06.000',
    `${name} speaks again`,
    '',
  ].join('\n');
}

interface TestOrigin {
  url: string;
  /** Every path the origin was asked for, in order — a source read twice shows up twice. */
  requests: string[];
  /** How many times one path was requested. */
  hits(path: string): number;
  close(): Promise<void>;
}

/**
 * The origin serves the subtitle files and the master playlist the catalogue
 * recorded, and remembers what it was asked for: how many times a title's source
 * text is downloaded is exactly what a batch of titles must not do twice.
 */
async function startOrigin(files: Record<string, string> = { '/subs/en.vtt': ENGLISH_VTT }): Promise<TestOrigin> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    requests.push(url);
    const file = files[url];
    if (file !== undefined) {
      response.writeHead(200, { 'content-type': 'text/vtt' });
      response.end(file);
      return;
    }
    if (url === '/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(MASTER_PLAYLIST);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('nothing here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    hits: (path) => requests.filter((item) => item === path).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface FakeDeepLCall {
  cues: string[];
  target: string;
}

/**
 * A stand-in for DeepL: same JSON-RPC shape, every cue prefixed with the target
 * language it was asked for. `failTargets` refuses named languages forever,
 * which is how a partial run — one language landing, another not — is
 * exercised; `failOnceTargets` refuses a language's *first* request only, which
 * is a rate limit that clears.
 */
async function startFakeDeepL(options: { failTargets?: string[]; failOnceTargets?: string[] } = {}): Promise<{ url: string; calls: FakeDeepLCall[]; close(): Promise<void> }> {
  const calls: FakeDeepLCall[] = [];
  const failTargets = new Set((options.failTargets ?? []).map((target) => target.toUpperCase()));
  const failOnceTargets = new Set((options.failOnceTargets ?? []).map((target) => target.toUpperCase()));
  const refusedOnce = new Set<string>();
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        params?: { texts?: Array<{ text?: string }>; lang?: { target_lang?: string } };
      };
      const texts = (parsed.params?.texts ?? []).map((entry) => entry.text ?? '');
      const target = parsed.params?.lang?.target_lang ?? '';
      calls.push({ cues: texts, target });
      response.writeHead(200, { 'content-type': 'application/json' });
      const once = failOnceTargets.has(target) && !refusedOnce.has(target);
      if (failTargets.has(target) || once) {
        if (once) refusedOnce.add(target);
        response.end(JSON.stringify({ error: { message: `${target} is not answerable right now` } }));
        return;
      }
      response.end(JSON.stringify({ result: { texts: texts.map((text) => ({ text: `${target.toLowerCase()}:${text}` })) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/jsonrpc`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RecordedCaption {
  videoId: string;
  srclang: string;
  label: string;
  body: string;
}

function fakeBunny(captions: RecordedCaption[]): BunnyClient {
  return {
    addCaption: async (videoId: string, srclang: string, label: string, content: string) => {
      captions.push({ videoId, srclang, label, body: content });
    },
  } as unknown as BunnyClient;
}

function movie(tmdbId: number, title: string): JobTarget {
  return { kind: 'movie', tmdbId, title, year: '2020' };
}

/** A published catalogue entry, built the way the pipeline builds one. */
function seed(
  catalog: Catalog,
  target: JobTarget,
  options: {
    videoId?: string;
    accountId?: string;
    source?: Partial<JobSource>;
    subtitles?: SubtitleTrack[];
    candidates?: JobCandidate[];
  } = {},
): CatalogEntry {
  const source: JobSource = { kind: 'stream', mode: 'scrape', name: 'seed', ...options.source };
  const job: Job = {
    ...newJob(target, source),
    status: 'ready',
    accountId: options.accountId ?? 'acc-1',
    bunnyVideoId: options.videoId ?? 'video-1',
    ...(options.subtitles ? { subtitles: options.subtitles } : {}),
    ...(options.candidates ? { candidates: options.candidates } : {}),
  };
  return catalog.record(job);
}

/** An English track that was attached, with the URL it was scraped from. */
function englishTrack(url: string): SubtitleTrack {
  return { srclang: 'en', label: 'English', url, uploaded: true, cues: 2, bytes: ENGLISH_VTT.length };
}

function arabicTrack(): SubtitleTrack {
  return { srclang: 'ar', label: 'العربية', uploaded: true, cues: 2, bytes: 100 };
}

/** What one run reported, shaped the way `SubtitleBackfill.run` returns it. */
function reportFor(outcome: BackfillOutcome): BackfillReport {
  return {
    targets: ['ar'],
    candidates: 1,
    attempted: 1,
    translated: outcome.status === 'translated' ? 1 : 0,
    failed: outcome.status === 'failed' ? 1 : 0,
    skipped: outcome.status === 'skipped' ? 1 : 0,
    remaining: outcome.status === 'translated' && !outcome.note ? 0 : 1,
    results: [outcome],
  };
}

/** A backfill that records which keys it was asked for, instead of working. */
function recordingBackfill(runs: string[], outcome: () => Promise<BackfillOutcome>): SubtitleBackfill {
  return {
    run: async (options: { keys?: string[] } = {}) => {
      runs.push((options.keys ?? []).join(','));
      return reportFor(await outcome());
    },
  } as unknown as SubtitleBackfill;
}

test('the preview lists the published titles still missing the target language', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const config = testConfig(dir);
  const catalog = new Catalog(config);
  const origin = await startOrigin();
  try {
    seed(catalog, movie(1, 'Missing Arabic'), { subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    seed(catalog, movie(2, 'Already Arabic'), { videoId: 'video-2', subtitles: [arabicTrack()] });
    seed(catalog, movie(3, 'No video'), { videoId: '', accountId: 'acc-1', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny([]) });
    const preview = backfill.preview();

    assert.deepEqual(preview.targets, ['ar']);
    assert.equal(preview.total, 2, 'the title that already has Arabic is not listed');
    const keys = preview.candidates.map((candidate) => candidate.key);
    assert.deepEqual(keys.sort(), ['movie:1', 'movie:3']);
    assert.equal(preview.candidates.find((candidate) => candidate.key === 'movie:1')?.from, `${origin.url}/subs/en.vtt`);
    // A title whose video id is missing is still listed — with the reason it
    // cannot be worked on, rather than hidden.
    assert.match(preview.candidates.find((candidate) => candidate.key === 'movie:3')?.note ?? '', /no Bunny video id/);
  } finally {
    await origin.close();
  }
});

test('a published title is translated from the subtitle the catalogue recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(11, 'From the recorded track'), {
      source: { url: `${origin.url}/master.m3u8`, headers: { Referer: origin.url } },
      subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)],
    });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();

    assert.equal(report.translated, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.skipped, 0);
    assert.equal(report.remaining, 0);

    // The caption went to the video that already exists, filed as Arabic.
    assert.equal(captions.length, 1);
    assert.equal(captions[0]?.videoId, 'video-1');
    assert.equal(captions[0]?.srclang, 'ar');
    assert.equal(captions[0]?.label, 'العربية (translated)');
    assert.match(captions[0]?.body ?? '', /^WEBVTT/);
    assert.match(captions[0]?.body ?? '', /ar:Hello there/);
    // The source timings are untouched: only the text was translated.
    assert.match(captions[0]?.body ?? '', /00:00:01\.000 --> 00:00:03\.000/);
    assert.match(captions[0]?.body ?? '', /00:00:04\.000 --> 00:00:06\.000/);
    // Nothing listens to the audio: the engine was handed the cue text only.
    assert.deepEqual(deepl.calls.map((call) => call.cues), [['Hello there', 'Second line']]);
    assert.equal(deepl.calls[0]?.target, 'AR');

    // The catalogue now says the title has Arabic, and where it came from.
    const entry = catalog.get('movie:11');
    assert.ok(entry);
    assert.equal(hasSubtitle(entry, 'ar'), true);
    const track = (entry.subtitles ?? []).find((item) => item.srclang === 'ar');
    assert.equal(track?.translated, true);
    assert.equal(track?.translatedFrom, 'en');
    assert.equal(track?.cues, 2);
    // …and the English track it was made from is still recorded.
    assert.deepEqual((entry.subtitles ?? []).map((item) => item.srclang).sort(), ['ar', 'en']);
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('a title with no recorded subtitle URL is worked out from its master playlist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    // No `subtitles` at all, and the source URL is the master the scrape found.
    seed(catalog, movie(21, 'Manifest only'), { source: { url: `${origin.url}/master.m3u8` } });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();

    assert.equal(report.translated, 1, JSON.stringify(report.results));
    assert.equal(captions[0]?.srclang, 'ar');
    assert.match(captions[0]?.body ?? '', /ar:Hello there/);
    assert.equal((catalog.get('movie:21')?.subtitles ?? []).find((track) => track.srclang === 'ar')?.translatedFrom, 'en');
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('a source that is gone is reported against the title, and nothing is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(31, 'Dead source'), {
      source: { url: `${origin.url}/missing-master.m3u8` },
      subtitles: [{ srclang: 'en', label: 'English', url: `${origin.url}/missing.vtt`, uploaded: false, note: 'the fetch failed' }],
    });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();

    assert.equal(report.translated, 0);
    assert.equal(report.failed, 1);
    const note = report.results[0]?.note ?? '';
    assert.match(note, /recorded en subtitle could not be read/);
    assert.match(note, /source could not be re-read/);
    assert.equal(captions.length, 0, 'nothing was uploaded');
    assert.deepEqual(catalog.get('movie:31')?.subtitles, [
      { srclang: 'en', label: 'English', url: `${origin.url}/missing.vtt`, uploaded: false, note: 'the fetch failed' },
    ]);
    assert.equal(hasSubtitle(catalog.get('movie:31') as CatalogEntry, 'ar'), false);
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('with translation switched off the run skips rather than inventing anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const config = testConfig(dir, { subtitleTranslate: false });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(41, 'Translation off'), { subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();
    assert.equal(report.translated, 0);
    assert.equal(report.skipped, 1);
    assert.match(report.results[0]?.note ?? '', /translation is switched off/);
    assert.equal(captions.length, 0);
  } finally {
    await origin.close();
  }
});

test('one press fills in every missing language from one read of the source text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url, subtitleTargetLanguages: ['ar', 'fr', 'es'] });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(61, 'Three languages'), { subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const preview = backfill.preview();
    assert.deepEqual(preview.targets, ['ar', 'fr', 'es']);
    assert.deepEqual(preview.candidates[0]?.missing, ['ar', 'fr', 'es']);

    const report = await backfill.run();
    assert.equal(report.translated, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.remaining, 0, 'report.remaining covers every target');
    assert.deepEqual(report.results[0]?.languages, ['ar', 'fr', 'es']);

    // Three captions on the one video, each filed under its own language.
    assert.deepEqual(
      captions.map((caption) => caption.srclang),
      ['ar', 'fr', 'es'],
    );
    assert.ok(captions.every((caption) => caption.videoId === 'video-1'));
    assert.match(captions[0]?.body ?? '', /ar:Hello there/);
    assert.match(captions[1]?.body ?? '', /fr:Hello there/);
    assert.match(captions[2]?.body ?? '', /es:Hello there/);
    // The source was read once and the cue text asked for once per language —
    // not for once per caption times the download.
    assert.deepEqual(
      deepl.calls.map((call) => call.target),
      ['AR', 'FR', 'ES'],
    );
    assert.ok(deepl.calls.every((call) => call.cues.join('|') === 'Hello there|Second line'));

    const tracks = catalog.get('movie:61')?.subtitles ?? [];
    assert.deepEqual(tracks.map((track) => track.srclang).sort(), ['ar', 'en', 'es', 'fr']);
    assert.ok(tracks.filter((track) => track.translated).every((track) => track.translatedFrom === 'en' && track.cues === 2));
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('a batch of titles downloads each source track once, however many languages it fills in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin({
    '/subs/one.vtt': titledVtt('one'),
    '/subs/two.vtt': titledVtt('two'),
    '/subs/three.vtt': titledVtt('three'),
  });
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url, subtitleTargetLanguages: ['ar', 'fr'] });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(81, 'Batch One'), { videoId: 'video-81', subtitles: [englishTrack(`${origin.url}/subs/one.vtt`)] });
    seed(catalog, movie(82, 'Batch Two'), { videoId: 'video-82', subtitles: [englishTrack(`${origin.url}/subs/two.vtt`)] });
    seed(catalog, movie(83, 'Batch Three'), { videoId: 'video-83', subtitles: [englishTrack(`${origin.url}/subs/three.vtt`)] });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();

    assert.equal(report.candidates, 3);
    assert.equal(report.translated, 3, JSON.stringify(report.results));
    assert.equal(report.failed, 0);
    assert.equal(report.remaining, 0);

    // Three titles times two missing languages is six translations but three
    // downloads: every title's source text was read once and reused for all of
    // its languages. A per-language re-read would show six requests here.
    assert.equal(origin.requests.length, 3, `the batch asked the origin for: ${origin.requests.join(', ')}`);
    for (const track of ['/subs/one.vtt', '/subs/two.vtt', '/subs/three.vtt']) {
      assert.equal(origin.hits(track), 1, `${track} was downloaded ${origin.hits(track)} times`);
    }
    assert.equal(origin.hits('/master.m3u8'), 0, 'the manifest is not needed: the recorded track is enough');

    // …and every language still got its own translation, from that title's cues.
    assert.equal(deepl.calls.length, 6);
    for (const name of ['one', 'two', 'three']) {
      const calls = deepl.calls.filter((call) => call.cues[0] === `Hello from ${name}`);
      assert.deepEqual(calls.map((call) => call.target), ['AR', 'FR'], `${name} is translated once per missing language`);
      assert.ok(calls.every((call) => call.cues.join('|') === `Hello from ${name}|${name} speaks again`));
    }

    // Six captions landed — one per title and language — on the video that was
    // already published, never a second video.
    assert.deepEqual(captions.map((caption) => caption.srclang).sort(), ['ar', 'ar', 'ar', 'fr', 'fr', 'fr']);
    for (const videoId of ['video-81', 'video-82', 'video-83']) {
      assert.deepEqual(
        captions.filter((caption) => caption.videoId === videoId).map((caption) => caption.srclang),
        ['ar', 'fr'],
      );
    }
    assert.match(captions.find((caption) => caption.videoId === 'video-82' && caption.srclang === 'fr')?.body ?? '', /fr:Hello from two/);

    // Every entry records both languages, each translated from its own English track.
    for (const key of ['movie:81', 'movie:82', 'movie:83']) {
      const tracks = catalog.get(key)?.subtitles ?? [];
      assert.deepEqual(tracks.map((track) => track.srclang).sort(), ['ar', 'en', 'fr']);
      assert.ok(tracks.filter((track) => track.translated).every((track) => track.translatedFrom === 'en'));
    }

    // Running the same batch again has nothing to do, and touches nothing: the
    // languages are attached, so no title is even a candidate.
    const again = await backfill.run();
    assert.equal(again.candidates, 0);
    assert.equal(again.attempted, 0);
    assert.equal(origin.requests.length, 3, 'a completed batch does not re-read anything');
    assert.equal(deepl.calls.length, 6, 'a completed batch does not translate anything twice');
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('one language failing leaves the others alone, and the run says which did not land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL({ failTargets: ['FR'] });
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url, subtitleTargetLanguages: ['ar', 'fr'] });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(71, 'Half translated'), { subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const report = await backfill.run();

    // The run still counts as translated: Arabic landed.
    assert.equal(report.translated, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.remaining, 1, 'French is still missing afterwards');
    assert.deepEqual(report.results[0]?.languages, ['ar']);
    assert.match(report.results[0]?.note ?? '', /attached ar/);
    assert.match(report.results[0]?.note ?? '', /not fr:/);

    // Only the language that landed is recorded; French is not claimed.
    assert.deepEqual(captions.map((caption) => caption.srclang), ['ar']);
    assert.deepEqual(
      (catalog.get('movie:71')?.subtitles ?? []).map((track) => track.srclang).sort(),
      ['ar', 'en'],
    );

    // A second run picks up only the language still missing: Arabic is not asked
    // for again, because it is already attached.
    const again = await backfill.run();
    assert.equal(again.candidates, 1, 'the title is still a candidate — fr is still missing');
    assert.equal(again.translated, 0);
    assert.equal(again.failed, 1);
    assert.match(again.results[0]?.note ?? '', /fr:/);
    assert.equal(deepl.calls.filter((call) => call.target === 'AR').length, 1, 'ar is attached, so it is not translated twice');
    assert.equal(deepl.calls.filter((call) => call.target === 'FR').length, 2);
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('keys and limit steer a run, and a title whose account is gone is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  try {
    seed(catalog, movie(51, 'One'), { videoId: 'video-51', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    seed(catalog, movie(52, 'Two'), { videoId: 'video-52', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    seed(catalog, movie(53, 'Three'), { videoId: 'video-53', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });

    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const limited = await backfill.run({ limit: 2 });
    assert.equal(limited.attempted, 2);
    assert.equal(limited.translated, 2);
    assert.equal(limited.remaining, 1, 'a batch that was cut short is still missing');

    // Whichever title the batch did not reach is the next run's work, addressed by
    // key rather than by guessing at the order.
    const left = catalog.all().filter((entry) => !hasSubtitle(entry, 'ar')).map((entry) => entry.key);
    assert.equal(left.length, 1);
    const one = await backfill.run({ keys: left });
    assert.equal(one.attempted, 1);
    assert.equal(one.translated, 1);
    assert.deepEqual([...captions.map((caption) => caption.videoId)].sort(), ['video-51', 'video-52', 'video-53']);

    // The client factory has the last word: an account that no longer exists
    // means the caption cannot be attached at all, and the run says so.
    seed(catalog, movie(54, 'Orphaned'), { videoId: 'video-54', accountId: 'acc-gone', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const orphan = new SubtitleBackfill({ config, catalog, client: (entry) => (entry.accountId === 'acc-1' ? fakeBunny(captions) : undefined) });
    const report = await orphan.run({ keys: ['movie:54'] });
    assert.equal(report.translated, 0);
    assert.equal(report.skipped, 1);
    assert.match(report.results[0]?.note ?? '', /account that published it is gone/);
    assert.equal(captions.length, 3, 'nothing was uploaded for the orphaned title');
    assert.equal(pivotTrack(catalog.get('movie:51') as CatalogEntry)?.srclang, 'en');
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('a publish that left a language missing is filled in without pressing anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL();
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  const lines: string[] = [];
  try {
    // The state a publish leaves behind when the translation was refused: the
    // English track uploaded, the Arabic one never created.
    seed(catalog, movie(91, 'Self healing'), { videoId: 'video-91', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const repair = new SubtitleAutoRepair({ config, catalog, backfill, retryDelayMs: 1, log: (line) => lines.push(line) });

    assert.equal(repair.consider(catalog.get('movie:91') as CatalogEntry), true, 'the publish came up short, so the repair takes it');
    await repair.idle();

    assert.deepEqual(captions.map((caption) => caption.srclang), ['ar']);
    assert.equal(captions[0]?.videoId, 'video-91');
    assert.equal(hasSubtitle(catalog.get('movie:91') as CatalogEntry, 'ar'), true);
    assert.equal(deepl.calls.length, 1);
    // The automatic pass reads the source text once, exactly like the button.
    assert.equal(origin.hits('/subs/en.vtt'), 1, `fetched ${origin.hits('/subs/en.vtt')} time(s)`);
    assert.ok(lines.some((line) => /filling it in automatically/.test(line)), lines.join(' | '));
    assert.ok(lines.some((line) => /attached ar/.test(line)), lines.join(' | '));
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('what an automatic pass cannot take from is left to the Library', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const config = testConfig(dir);
  const catalog = new Catalog(config);
  const runs: string[] = [];
  try {
    const stub = recordingBackfill(runs, async () => ({ key: 'x', title: 'x', status: 'skipped' }));
    const repair = new SubtitleAutoRepair({ config, catalog, backfill: stub });

    const complete = seed(catalog, movie(92, 'Complete'), {
      videoId: 'video-92',
      subtitles: [englishTrack(`${origin.url}/subs/en.vtt`), arabicTrack()],
    });
    assert.deepEqual(repairable(complete, ['ar']), [], 'every configured language is attached');
    assert.equal(repair.consider(complete), false);

    const noVideo = seed(catalog, movie(93, 'No video'), { videoId: '', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    assert.deepEqual(repairable(noVideo, ['ar']), [], 'there is no video to attach a caption to');
    assert.equal(repair.consider(noVideo), false);

    // The publish never read any cue text, so there is nothing to translate from:
    // re-running discovery on every event would repeat the same failure.
    const unreadable = seed(catalog, movie(94, 'Unreadable source'), {
      videoId: 'video-94',
      subtitles: [{ srclang: 'en', label: 'English', url: `${origin.url}/subs/en.vtt`, uploaded: false, note: 'the subtitle file held no cues' }],
    });
    assert.equal(readablePivot(unreadable), undefined);
    assert.deepEqual(repairable(unreadable, ['ar']), []);
    assert.equal(repair.consider(unreadable), false);

    const wanted = seed(catalog, movie(95, 'Switched off'), { videoId: 'video-95', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    assert.equal(repair.consider(wanted), true, 'this one would be repaired…');
    assert.equal(
      new SubtitleAutoRepair({ config, catalog, backfill: stub, enabled: () => false }).consider(wanted),
      false,
      '…but the operator turned the setting off',
    );
    assert.equal(
      new SubtitleAutoRepair({ config: testConfig(dir, { subtitleTranslate: false }), catalog, backfill: stub }).consider(wanted),
      false,
      'translation is off, so nothing could be created',
    );

    assert.deepEqual(runs, ['movie:95'], 'only the one title that was actually wanted was run');
  } finally {
    await origin.close();
  }
});

test('one title is only repaired once while its repair is in flight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const config = testConfig(dir);
  const catalog = new Catalog(config);
  const runs: string[] = [];
  try {
    seed(catalog, movie(96, 'In flight'), { videoId: 'video-96', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = recordingBackfill(runs, async () => {
      await gate;
      return { key: 'movie:96', title: 'In flight', status: 'translated', languages: ['ar'], cues: 2, bytes: 10 };
    });
    const repair = new SubtitleAutoRepair({ config, catalog, backfill: stub });
    const entry = catalog.get('movie:96') as CatalogEntry;

    assert.equal(repair.consider(entry), true);
    // A second event for the same title — another publish, a re-delivered
    // change — must not put it in line twice.
    assert.equal(repair.consider(catalog.get('movie:96') as CatalogEntry), false);
    release();
    await repair.idle();
    assert.deepEqual(runs, ['movie:96']);
  } finally {
    await origin.close();
  }
});

test('a refused repair tries again, then leaves the title to the Library', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL({ failTargets: ['AR'] });
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  const lines: string[] = [];
  try {
    seed(catalog, movie(97, 'Rate limited'), { videoId: 'video-97', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const repair = new SubtitleAutoRepair({ config, catalog, backfill, retryDelayMs: 1, log: (line) => lines.push(line) });

    assert.equal(repair.consider(catalog.get('movie:97') as CatalogEntry), true);
    await repair.idle();

    assert.equal(deepl.calls.filter((call) => call.target === 'AR').length, 3, 'three attempts, then the budget is spent');
    assert.equal(captions.length, 0);
    assert.equal(hasSubtitle(catalog.get('movie:97') as CatalogEntry, 'ar'), false);
    assert.ok(lines.some((line) => /trying again/.test(line)), lines.join(' | '));
    assert.ok(lines.some((line) => /gave up after 3 attempt/.test(line)), lines.join(' | '));
    // Nothing was invented, and the Library's button is still where a person
    // goes to see why.
    const pressed = await backfill.run({ keys: ['movie:97'] });
    assert.equal(pressed.failed, 1);
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('a rate limit that clears is healed by the retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const deepl = await startFakeDeepL({ failOnceTargets: ['AR'] });
  const config = testConfig(dir, { subtitleTranslateEndpoint: deepl.url });
  const catalog = new Catalog(config);
  const captions: RecordedCaption[] = [];
  const lines: string[] = [];
  try {
    seed(catalog, movie(98, 'Second time lucky'), { videoId: 'video-98', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const backfill = new SubtitleBackfill({ config, catalog, client: () => fakeBunny(captions) });
    const repair = new SubtitleAutoRepair({ config, catalog, backfill, retryDelayMs: 1, maxAttempts: 3, log: (line) => lines.push(line) });

    assert.equal(repair.consider(catalog.get('movie:98') as CatalogEntry), true);
    await repair.idle();

    assert.deepEqual(captions.map((caption) => caption.srclang), ['ar']);
    assert.equal(deepl.calls.filter((call) => call.target === 'AR').length, 2, 'refused once, answered the second time');
    assert.equal(hasSubtitle(catalog.get('movie:98') as CatalogEntry, 'ar'), true);
    assert.ok(lines.some((line) => /trying again/.test(line)), lines.join(' | '));
    assert.ok(lines.some((line) => /attached ar/.test(line)), lines.join(' | '));
  } finally {
    await deepl.close();
    await origin.close();
  }
});

test('stopping the repair drops what was still waiting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-backfill-'));
  const origin = await startOrigin();
  const config = testConfig(dir);
  const catalog = new Catalog(config);
  const runs: string[] = [];
  const lines: string[] = [];
  try {
    seed(catalog, movie(99, 'Shutting down'), { videoId: 'video-99', subtitles: [englishTrack(`${origin.url}/subs/en.vtt`)] });
    const stub = recordingBackfill(runs, async () => ({ key: 'movie:99', title: 'Shutting down', status: 'failed', note: 'refused' }));
    const repair = new SubtitleAutoRepair({ config, catalog, backfill: stub, retryDelayMs: 30, log: (line) => lines.push(line) });

    assert.equal(repair.consider(catalog.get('movie:99') as CatalogEntry), true);
    await waitFor(() => runs.length === 1 && lines.some((line) => /trying again/.test(line)), 'the retry to be scheduled');
    repair.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(runs, ['movie:99'], 'the pending retry never ran');
    assert.equal(repair.consider(catalog.get('movie:99') as CatalogEntry), false, 'a stopped repair takes nothing new');
  } finally {
    await origin.close();
  }
});
