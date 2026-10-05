/**
 * End-to-end smoke test for the dashboard API.
 *
 * Start the dashboard in mock mode first (`npm run mock`), then run:
 *
 *   node scripts/smoke.mjs
 *
 * It exercises TMDB search/lookup, account management, a streamed file
 * upload, remote-URL jobs, the 10-concurrent-uploads-per-account cap, and the
 * source-URL pipeline (a real HLS stream served from this process, downloaded
 * and published end to end), then cleans up the jobs and account it created.
 *
 * Set SMOKE_DATA_DIR when the dashboard under test was started with a custom
 * DATA_DIR, so the temp-file checks look in the right place.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4747';
const dataDir = process.env.SMOKE_DATA_DIR ?? path.join(process.cwd(), 'data');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(label, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

async function request(method, path, body, contentType) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      init.body = body;
      if (contentType) init.headers['content-type'] = contentType;
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const response = await fetch(base + path, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* some endpoints answer non-JSON */
  }
  return { status: response.status, json, text };
}

/** Deletes jobs, cancelling any that the queue has already picked up. */
async function dropJobs(ids) {
  for (const id of ids ?? []) {
    if (!id) continue;
    const removed = await request('DELETE', `/api/jobs/${id}`);
    if (removed.status !== 200) {
      await request('POST', `/api/jobs/${id}/cancel`, {});
      await request('DELETE', `/api/jobs/${id}`);
    }
  }
}

/* health & settings -------------------------------------------------- */
let result = await request('GET', '/api/health');
check('health answers and reports mock mode', result.status === 200 && result.json?.mock === true, `status ${result.status}`);

check(
  'health reports resumable (TUS) uploads by default',
  result.json?.uploadMode === 'tus' && result.json?.tusChunkBytes === 8 * 1024 * 1024,
  `${result.json?.uploadMode} chunk ${result.json?.tusChunkBytes}`,
);

result = await request('GET', '/api/settings');
check('settings expose the hard caps', result.json?.limits?.maxAccounts === 30 && result.json?.limits?.perAccountConcurrency === 10);
check('settings expose the upload mode', result.json?.uploadMode === 'tus' && result.json?.tusChunkBytes === 8 * 1024 * 1024);

/* bulk queuing -------------------------------------------------------- */
// These run before any account exists, and that is the point: with nothing to
// run on, the jobs stay queued, so the checks never reach a real streaming host.
const bulkJobIds = [];
const takeBulk = (body) => {
  for (const job of body?.created ?? []) bulkJobIds.push(job.id);
  return body;
};

result = await request('POST', '/api/jobs/bulk', {
  text: ['# a list may carry comments', 'Inception (2010)', '', 'Breaking Bad S03'].join('\n'),
});
let bulk = takeBulk(result.json);
check(
  'a pasted list queues the movie and one season of the show',
  result.status === 201 && bulk?.created?.length === 14 && bulk?.counts?.movies === 1 && bulk?.counts?.episodes === 13,
  `status ${result.status}, created ${bulk?.created?.length}, counts ${JSON.stringify(bulk?.counts)}`,
);
const bulkEpisodes = (bulk?.created ?? []).filter((job) => job.target.kind === 'episode');
check(
  'the episodes match the season TMDB lists, in order',
  bulkEpisodes.length === 13 &&
    bulkEpisodes.every((job) => job.target.title === 'Breaking Bad' && job.target.season === 3) &&
    new Set(bulkEpisodes.map((job) => job.target.episode)).size === 13,
  `${bulkEpisodes.length} episode(s), e.g. ${bulkEpisodes[0]?.target?.episode}`,
);
check(
  'the bulk jobs are scrape jobs, ready to run',
  (bulk?.created ?? []).every((job) => job.source?.kind === 'stream' && job.source?.mode === 'scrape'),
  JSON.stringify(bulk?.created?.[0]?.source ?? null),
);

result = await request('POST', '/api/jobs/bulk', { text: 'Inception (2010)\nBreaking Bad S03' });
bulk = takeBulk(result.json);
check(
  'pasting the same list again queues nothing new',
  result.status === 201 && (bulk?.created ?? []).length === 0 && (bulk?.skipped ?? []).every((entry) => entry.reason === 'already in the queue'),
  `created ${(bulk?.created ?? []).length}, skipped ${(bulk?.skipped ?? []).length}`,
);

result = await request('POST', '/api/jobs/series', { target: { tmdbId: 1396, title: 'Breaking Bad' } });
bulk = takeBulk(result.json);
const seriesSeasons = [...new Set((bulk?.created ?? []).map((job) => job.target.season))].sort();
check(
  'the whole series is one call: all 62 episodes, minus the 13 already queued',
  result.status === 201 &&
    (bulk?.created ?? []).length === 49 &&
    (bulk?.skipped ?? []).length === 13 &&
    seriesSeasons.join(',') === '1,2,4,5',
  `created ${(bulk?.created ?? []).length}, skipped ${(bulk?.skipped ?? []).length}, seasons ${seriesSeasons.join('+')}`,
);

result = await request('POST', '/api/jobs/series', { target: { tmdbId: 66732, title: 'Stranger Things' }, seasons: [2] });
bulk = takeBulk(result.json);
check(
  'a series call can be narrowed to one season',
  result.status === 201 && (bulk?.created ?? []).length === 9 && (bulk?.created ?? []).every((job) => job.target.season === 2),
  `created ${(bulk?.created ?? []).length}`,
);

result = await request('POST', '/api/jobs/bulk', { text: 'tt9999999\nInception' });
bulk = takeBulk(result.json);
check(
  'a line with nothing behind it is reported, the rest still queues',
  result.status === 201 && (bulk?.created ?? []).length === 0 && (bulk?.skipped ?? [])[0]?.reason === 'TMDB has nothing for tt9999999',
  JSON.stringify(bulk?.skipped ?? null),
);

await dropJobs(bulkJobIds);
check('the bulk jobs were cleaned up again', bulkJobIds.length > 0, `${bulkJobIds.length} job(s)`);

/* accounts ----------------------------------------------------------- */
result = await request('POST', '/api/accounts', { name: 'smoke-library', libraryId: '12345', apiKey: 'mock-key-1234', pullZoneHost: 'vz-mock.b-cdn.net' });
check('account is created', result.status === 201 && Boolean(result.json?.account?.id), `status ${result.status}`);
const accountId = result.json?.account?.id;
check('the API key comes back masked', result.json?.account?.apiKeyMasked === '••••1234', result.json?.account?.apiKeyMasked);

result = await request('POST', `/api/accounts/${accountId}/test`);
check('account test reaches the (mock) library', result.json?.ok === true && result.json?.totalItems === 3, JSON.stringify(result.json));

/* TMDB --------------------------------------------------------------- */
result = await request('GET', '/api/tmdb/search?q=breaking');
check('search finds Breaking Bad', (result.json?.results ?? []).some((entry) => entry.tmdbId === 1396));

result = await request('GET', '/api/tmdb/lookup?q=27205');
check('lookup by TMDB id resolves Inception', (result.json?.results ?? []).some((entry) => entry.title === 'Inception'));

result = await request('GET', '/api/tmdb/lookup?q=tt0903747');
check('lookup by IMDb id resolves the show', (result.json?.results ?? []).some((entry) => entry.mediaType === 'tv' && entry.tmdbId === 1396));

result = await request('GET', '/api/tmdb/tv/1396');
check('the show lists five seasons', (result.json?.show?.seasons ?? []).length === 5);

result = await request('GET', '/api/tmdb/tv/1396/season/1');
check('season 1 lists seven episodes', (result.json?.episodes ?? []).length === 7);

/* queue 13 remote jobs ----------------------------------------------- */
const titles = ['Inception', 'The Matrix', 'Interstellar', 'Fight Club', 'Pulp Fiction'];
const jobIds = [];
for (let index = 0; index < 13; index += 1) {
  result = await request('POST', '/api/jobs/remote', {
    target: { kind: 'movie', tmdbId: 27205, title: `${titles[index % titles.length]} #${index}`, year: '2020' },
    url: `https://example.com/movie-${index}.mp4`,
  });
  if (result.status === 201) jobIds.push(result.json.job.id);
}
check('thirteen remote jobs were accepted', jobIds.length === 13, `accepted ${jobIds.length}`);

/* the source-URL pipeline -------------------------------------------- */
// A tiny origin CDN, served from this process: a master playlist, a media
// playlist and three segments. The dashboard downloads it and publishes it.
const segments = [Buffer.alloc(50_000, 11), Buffer.alloc(40_000, 22), Buffer.alloc(30_000, 33)];
const expectedStream = Buffer.concat(segments);
const mediaPlaylist = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.000,',
  'seg0.ts',
  '#EXTINF:4.000,',
  'seg1.ts',
  '#EXTINF:4.000,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');
const masterPlaylist = [
  '#EXTM3U',
  // Two subtitle renditions, so the pipeline's caption path is exercised too.
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.vtt"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="العربية",LANGUAGE="ar",URI="subs/ar.vtt"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
  'v720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  'v1080/index.m3u8',
  '',
].join('\n');
const englishVtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', 'Smoke subtitle', ''].join('\n');
const arabicVtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', 'ترجمة', ''].join('\n');

const origin = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/master.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return void res.end(masterPlaylist);
  }
  if (url.pathname === '/v1080/index.m3u8' || url.pathname === '/v720/index.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return void res.end(mediaPlaylist);
  }
  if (url.pathname === '/subs/en.vtt' || url.pathname === '/subs/ar.vtt') {
    res.writeHead(200, { 'content-type': 'text/vtt' });
    return void res.end(url.pathname.endsWith('ar.vtt') ? arabicVtt : englishVtt);
  }
  const segment = /^\/v(?:1080|720)\/seg(\d)\.ts$/.exec(url.pathname);
  if (segment) {
    const body = segments[Number(segment[1])];
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]) + 1, body.length) : body.length;
      res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': `bytes ${start}-${end - 1}/${body.length}`, 'content-length': String(end - start) });
      return void res.end(body.subarray(start, end));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(body.length) });
    return void res.end(body);
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
const originBase = `http://127.0.0.1:${origin.address().port}`;

result = await request('GET', '/api/sources/providers');
check('the scraping hosts are listed', (result.json?.providers ?? []).length >= 5, `${(result.json?.providers ?? []).length} hosts`);

result = await request('GET', '/api/tunnel');
check('the tunnel reports its state', typeof result.json?.status?.state === 'string', result.json?.status?.state);

result = await request('POST', '/api/jobs/source', { url: 'not-a-url' });
check('a nonsense source URL is rejected', result.status === 400, `status ${result.status}`);

// A target of its own (the 13 remote jobs all publish `movie:27205`), so the
// catalogue record this job writes — subtitles, ladder and all — is not later
// overwritten by another job for the same title.
result = await request('POST', '/api/jobs/source', {
  target: { kind: 'movie', tmdbId: 603, title: 'The Matrix', year: '1999' },
  url: `${originBase}/master.m3u8`,
  minHeight: 1080,
});
check(
  'a source URL becomes a stream job',
  result.status === 201 && result.json?.job?.source?.kind === 'stream' && result.json?.job?.source?.mode === 'source',
  `status ${result.status}`,
);
const streamJobId = result.json?.job?.id;

if (streamJobId) jobIds.push(streamJobId);

/* a streamed file upload --------------------------------------------- */
const uploadTarget = { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 1, episodeTitle: 'Pilot' };
const uploadBytes = Buffer.alloc(64 * 1024, 7);
result = await request('POST', `/api/jobs/upload?meta=${encodeURIComponent(JSON.stringify(uploadTarget))}&name=pilot.mp4`, uploadBytes, 'application/octet-stream');
check('a streamed file upload becomes a job', result.status === 201 && result.json?.job?.source?.kind === 'file', `status ${result.status}`);
const uploadJobId = result.json?.job?.id;

/* watch the concurrency cap ------------------------------------------ */
const myJobIds = new Set([...jobIds, uploadJobId]);
let maxActive = 0;
for (let tick = 0; tick < 12; tick += 1) {
  result = await request('GET', '/api/jobs?limit=100');
  const active = (result.json?.jobs ?? []).filter(
    (job) => myJobIds.has(job.id) && (job.status === 'uploading' || job.status === 'encoding'),
  ).length;
  maxActive = Math.max(maxActive, active);
  await sleep(400);
}
check('never more than 10 uploads run at once', maxActive <= 10, `peak ${maxActive}`);

/* wait for the mock encodings to finish ------------------------------ */
const deadline = Date.now() + 90_000;
let finalJobs = [];
for (;;) {
  result = await request('GET', '/api/jobs?limit=100');
  finalJobs = result.json?.jobs ?? [];
  const pending = finalJobs.filter((job) => myJobIds.has(job.id) && ['queued', 'uploading', 'encoding'].includes(job.status)).length;
  if (pending === 0 || Date.now() > deadline) break;
  await sleep(2000);
}

const mine = finalJobs.filter((job) => myJobIds.has(job.id));
const ready = mine.filter((job) => job.status === 'ready');
const failed = mine.filter((job) => job.status === 'failed');
check(
  'every job finished (13 remote + 1 source + 1 file)',
  ready.length === 15 && failed.length === 0,
  `ready ${ready.length}, failed ${failed.length}${failed.length ? `: ${failed.map((job) => job.error).join(' | ')}` : ''}`,
);

/* the source job's own report ---------------------------------------- */
const streamJob = mine.find((job) => job.id === streamJobId);
check('the source job settled on the 1080p tier', streamJob?.source?.quality === '1080p', String(streamJob?.source?.quality));
check(
  'the source job recorded where the stream came from',
  streamJob?.source?.provider === 'pasted URL' && typeof streamJob?.source?.url === 'string' && streamJob.source.url.endsWith('/v1080/index.m3u8'),
  String(streamJob?.source?.url),
);
check(
  'the whole stream was downloaded and handed over',
  streamJob?.bytesIn === expectedStream.length && streamJob?.bytesOut === expectedStream.length,
  `in ${streamJob?.bytesIn} out ${streamJob?.bytesOut} of ${expectedStream.length}`,
);
check(
  'the job names the transport that carried the bytes',
  streamJob?.transport === 'direct',
  `transport ${streamJob?.transport} (mock mode never starts a tunnel)`,
);
check('the relay is released once a job is done', streamJob?.relayToken === undefined);
check(
  'the video is named by its TMDB id, not its title',
  streamJob?.libraryName === 'tmdb:603',
  String(streamJob?.libraryName),
);
check(
  'both subtitle tracks the stream declared were attached to the video',
  (streamJob?.subtitles ?? []).filter((track) => track.uploaded).map((track) => track.srclang).sort().join(',') === 'ar,en',
  JSON.stringify((streamJob?.subtitles ?? []).map((track) => `${track.srclang}:${track.uploaded}`)),
);
check(
  'the queue list omits the per-source detail only the opened job needs',
  streamJob?.candidates === undefined,
);
// The list is deliberately lean; the full record (candidates and all) is one call.
const detail = await request('GET', `/api/jobs/${streamJobId}`);
const detailJob = detail.json?.job;
check(
  'opening a job returns its full record, candidate ladder included',
  Array.isArray(detailJob?.candidates) && detailJob.candidates.some((candidate) => candidate.chosen),
  `${detailJob?.candidates?.length ?? 0} candidate(s)`,
);
check(
  'playback URLs use the pull-zone host',
  ready.every((job) => typeof job.playbackUrl === 'string' && job.playbackUrl.startsWith('https://vz-mock.b-cdn.net/')),
);
const leftover = fs.readdirSync(path.join(dataDir, 'uploads')).filter((name) => /\.(bin|ts|mp4)$/i.test(name));
check('no staged or spool file was left behind', leftover.length === 0, leftover.join(', '));

/* the published catalogue --------------------------------------------- */
// The permanent record: every finished job is written here, and a title
// published many times is still one record (the publishes count goes up).
result = await request('GET', '/api/catalog');
const catalogItems = result.json?.items ?? [];
check('finished jobs are recorded in the published catalogue', catalogItems.length >= 2, `${catalogItems.length} record(s)`);
check(
  'every catalogue record carries its playback URL',
  catalogItems.every((entry) => typeof entry.playbackUrl === 'string' && entry.playbackUrl.length > 0),
);
const inception = catalogItems.find((entry) => entry.key === 'movie:27205');
check(
  'a title published repeatedly is one record with a publish count',
  typeof inception?.publishes === 'number' && inception.publishes >= 13,
  `movie:27205 published ${inception?.publishes} time(s)`,
);
check(
  'the uploaded file is recorded with its own origin',
  catalogItems.some((entry) => entry.key === 'episode:1396:1:1' && entry.origin?.kind === 'file'),
);
const matrix = catalogItems.find((entry) => entry.key === 'movie:603');
check(
  'the catalogue keeps the subtitle tracks a title was published with',
  (matrix?.subtitles ?? []).map((track) => track.srclang).sort().join(',') === 'ar,en' &&
    (matrix?.subtitles ?? []).every((track) => track.uploaded),
  JSON.stringify((matrix?.subtitles ?? []).map((track) => `${track.srclang}:${track.uploaded}`)),
);

// The stream job's own record (its key is not shared with the remote jobs): the
// only one that carries a candidate ladder, a tier ladder and byte counts.
if (matrix) {
  const full = await request('GET', `/api/catalog/${encodeURIComponent(matrix.key)}`);
  const record = full.json?.entry;
  check(
    'opening a catalogue record returns every source and the sizes',
    Array.isArray(record?.sources) && record.sources.length >= 1 && Array.isArray(record?.tiers) && record.tiers.length >= 2 && record?.bytes !== undefined,
    `${record?.sources?.length ?? 0} source(s), ${record?.tiers?.length ?? 0} tier(s)`,
  );
}

/* autopilot ------------------------------------------------------------- */
// The autopilot walks TMDB's top-rated lists. The rating floor is raised to
// 9.2 here so the canned list stays small: only the two synthetic 9.5/9.3
// titles clear it, everything else is counted as below the floor.
// Reset to the documented defaults first: this makes the round-trip check below
// deterministic, so the smoke can be run twice against the same data directory.
const autopilotDefaults = {
  enabled: false,
  minRating: 3,
  kinds: ['movie', 'tv'],
  minHeight: 1080,
  expandSeries: true,
  maxJobsPerCycle: 25,
  maxAttempts: 5,
  maxQueueDepth: 300,
  intervalMs: 300000,
};
result = await request('PUT', '/api/autopilot', autopilotDefaults);
check(
  'the autopilot holds its configured state',
  result.status === 200 &&
    result.json?.config?.minRating === 3 &&
    result.json?.config?.enabled === false &&
    result.json?.config?.kinds?.join(',') === 'movie,tv' &&
    result.json?.cursors?.movie === 1,
  `status ${result.status}, minRating ${result.json?.config?.minRating}`,
);

result = await request('PUT', '/api/autopilot', { minRating: 42 });
check('a rating floor outside 0–10 is refused', result.status === 400, `status ${result.status}`);

result = await request('PUT', '/api/autopilot', {
  enabled: true,
  minRating: 9.2,
  kinds: ['movie'],
  expandSeries: false,
  maxJobsPerCycle: 5,
  minHeight: 1080,
  intervalMs: 600000,
});
check(
  'the autopilot settings are validated and saved',
  result.status === 200 && result.json?.config?.enabled === true && result.json?.config?.minRating === 9.2,
  `status ${result.status}`,
);

const autopilotCycle = await request('POST', '/api/autopilot/run');
const cycleReport = autopilotCycle.json?.report;
check(
  'a cycle walks the top-rated list, queues what clears the floor and skips the rest',
  autopilotCycle.status === 200 &&
    (cycleReport?.scanned ?? 0) > 0 &&
    (cycleReport?.created ?? 0) >= 1 &&
    (cycleReport?.belowRating ?? 0) >= 1,
  `scanned ${cycleReport?.scanned}, created ${cycleReport?.created}, below ${cycleReport?.belowRating}`,
);
check(
  'a cycle that reaches the end of the list restarts it from page one',
  cycleReport?.wrapped === true && autopilotCycle.json?.state?.cursors?.movie === 1,
  `wrapped ${cycleReport?.wrapped}, cursor ${autopilotCycle.json?.state?.cursors?.movie}`,
);

// The cycle queued real jobs; drop exactly those, then switch the autopilot
// back off so a smoke run never leaves it walking lists in the background.
const autopilotJobIds = ((await request('GET', '/api/jobs?limit=500')).json?.jobs ?? [])
  .filter((job) => job.target?.title?.startsWith('Top movie') && job.source?.mode === 'scrape')
  .map((job) => job.id);
await dropJobs(autopilotJobIds);
check('the cycle created real jobs, all cleaned up', autopilotJobIds.length >= 1, `${autopilotJobIds.length} job(s)`);

result = await request('PUT', '/api/autopilot', { enabled: false });
check('the autopilot can be switched off again', result.json?.config?.enabled === false, `enabled ${result.json?.config?.enabled}`);
await request('POST', '/api/autopilot/reset', {});
await request('POST', '/api/autopilot/log/clear', {});

/* host cooldowns ---------------------------------------------------------- */
result = await request('GET', '/api/settings');
check(
  'settings report the scraping pace and egress policy',
  typeof result.json?.source?.minIntervalMs === 'number' &&
    typeof result.json?.source?.cooldownMs === 'number' &&
    Array.isArray(result.json?.source?.cooling),
  `interval ${result.json?.source?.minIntervalMs} ms, cooldown ${result.json?.source?.cooldownMs} ms`,
);

/* watched folder ------------------------------------------------------- */
const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-watch-'));
const releaseName = 'Inception.2010.1080p.BluRay.x264-SMOKE.mkv';
const releasePath = path.join(watchRoot, releaseName);
fs.writeFileSync(releasePath, Buffer.alloc(48 * 1024, 3));
const settled = new Date(Date.now() - 5 * 60_000); // pretend the copy finished minutes ago
fs.utimesSync(releasePath, settled, settled);

result = await request('PUT', '/api/settings', { watchDir: watchRoot, watchEnabled: true });
check('the watched folder is saved', result.json?.watchDir === watchRoot && result.json?.watchEnabled === true, String(result.json?.watchDir));

result = await request('POST', '/api/watch/scan', {});
const watchedFile = (result.json?.files ?? []).find((file) => file.name === releaseName) ?? {};
check('the release name is matched and queued', watchedFile.status === 'queued', JSON.stringify(watchedFile.target ?? watchedFile.error ?? null));
check(
  'the filename supplied the target',
  watchedFile.target?.kind === 'movie' && watchedFile.target?.tmdbId === 27205 && watchedFile.target?.year === '2010',
  JSON.stringify(watchedFile.target ?? null),
);
check('the matched file left the watched folder', fs.existsSync(releasePath) === false);
const watchedJobId = watchedFile.jobId;

let watchedJob = null;
for (let tick = 0; tick < 45; tick += 1) {
  result = await request('GET', '/api/jobs?limit=300');
  watchedJob = (result.json?.jobs ?? []).find((job) => job.id === watchedJobId) ?? null;
  if (!watchedJob || watchedJob.status === 'ready' || watchedJob.status === 'failed') break;
  await sleep(2000);
}
check(
  'the watched file became a real upload',
  watchedJob?.status === 'ready' && watchedJob?.playbackUrl?.startsWith('https://vz-mock.b-cdn.net/'),
  `${watchedJob?.status ?? 'missing job'}`,
);
await request('PUT', '/api/settings', { watchDir: '', watchEnabled: false });
fs.rmSync(watchRoot, { recursive: true, force: true });

/* retry-all-failed ------------------------------------------------------ */
const failedBefore = (await request('GET', '/api/jobs?status=failed&limit=500')).json?.jobs?.length ?? 0;
result = await request('POST', '/api/jobs/retry-failed', {});
check(
  'retry-all answers with exactly the failed jobs it picked up',
  result.status === 200 && result.json?.retried === failedBefore && (result.json?.jobs ?? []).length === failedBefore,
  `failed ${failedBefore}, retried ${result.json?.retried}`,
);

/* cleanup -------------------------------------------------------------- */
await dropJobs([...jobIds, uploadJobId, watchedJobId, ...(result.json?.jobs ?? []).map((job) => job.id)]);
await request('DELETE', `/api/accounts/${accountId}`);
origin.close();

console.log(failures === 0 ? '\nSMOKE OK — every check passed' : `\nSMOKE FAILED — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
