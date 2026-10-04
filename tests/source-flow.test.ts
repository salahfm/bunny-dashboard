/**
 * The source pipeline, end to end over real HTTP.
 *
 * A tiny origin server stands in for an embed host's CDN: a master playlist with
 * two tiers, a media playlist and segments that arrive slowly enough for the test
 * to see the download and the upload overlap. The relay is served by a second
 * real HTTP server, which is what a fake Bunny fetches from — so "Bunny pulls
 * through the tunnel" is exercised rather than mocked, and the bytes it receives
 * are compared with the bytes the origin published.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BunnyClient } from '../src/bunny';
import { parseMasterPlaylist, parseMediaPlaylist, StreamSpool } from '../src/hls';
import { RelayHub } from '../src/relay';
import { Store } from '../src/store';
import { chooseCandidate, runStreamJob } from '../src/stream';
import { TunnelManager } from '../src/tunnel';
import { testConfig } from './helpers';

const SEGMENT_BYTES = [40_000, 30_000, 20_000, 10_000];

function segmentBuffer(index: number): Buffer {
  const buffer = Buffer.alloc(SEGMENT_BYTES[index] ?? 1_000);
  for (let offset = 0; offset < buffer.length; offset += 1) buffer[offset] = (index * 31 + offset) % 251;
  return buffer;
}

interface Origin {
  url: string;
  masterUrl: string;
  /** The exact bytes a correct download must produce (init segment included). */
  expected: Buffer;
  close(): Promise<void>;
}

/** An origin CDN: master playlist, one media playlist, ranged segment responses. */
async function startOrigin(options: { delayMs?: number; includeInit?: boolean } = {}): Promise<Origin> {
  const delayMs = options.delayMs ?? 0;
  const init = Buffer.from('INITSEGMENT');
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    ...(options.includeInit ? [`#EXT-X-MAP:URI="init.mp4"`] : []),
    '#EXTINF:4.000,',
    'seg0.ts',
    '#EXTINF:4.000,',
    'seg1.ts',
    '#EXTINF:4.000,',
    'seg2.ts',
    '#EXTINF:4.000,',
    'seg3.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
    'v720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'v1080/index.m3u8',
    '',
  ].join('\n');

  const expected = Buffer.concat([...(options.includeInit ? [init] : []), ...SEGMENT_BYTES.map((_, index) => segmentBuffer(index))]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (body: Buffer, type: string) => {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]) + 1, body.length) : body.length;
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end - 1}/${body.length}`,
          'Content-Length': String(end - start),
        });
        res.end(body.subarray(start, end));
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(body.length) });
      res.end(body);
    };
    const delay = (fn: () => void) => (delayMs ? setTimeout(fn, delayMs) : fn());

    if (url.pathname === '/master.m3u8') return send(Buffer.from(master, 'utf8'), 'application/vnd.apple.mpegurl');
    if (url.pathname === '/v1080/index.m3u8' || url.pathname === '/v720/index.m3u8') {
      return send(Buffer.from(media, 'utf8'), 'application/vnd.apple.mpegurl');
    }
    if (url.pathname === '/v1080/init.mp4' || url.pathname === '/v720/init.mp4') {
      return send(init, 'video/mp4');
    }
    const segment = /^\/v(?:1080|720)\/seg(\d)\.ts$/.exec(url.pathname);
    if (segment) return delay(() => send(segmentBuffer(Number(segment[1])), 'video/mp2t'));
    res.writeHead(404).end('nope');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    masterUrl: `http://127.0.0.1:${port}/master.m3u8`,
    expected,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startRelayServer(hub: RelayHub): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(hub.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-source-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  return dir;
}

test('a master playlist is read best-first and labelled', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
    'v720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'v1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160',
    'v2160/index.m3u8',
  ].join('\n');
  const variants = parseMasterPlaylist(text, 'https://cdn.example/master.m3u8');
  assert.deepEqual(
    variants.map((variant) => variant.label),
    ['4K', '1080p', '720p'],
  );
  assert.equal(variants[1]?.url, 'https://cdn.example/v1080/index.m3u8');
});

test('a media playlist keeps segments, byte ranges and keys in order', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
    '#EXTINF:5.005,',
    '#EXT-X-BYTERANGE:1024@0',
    'all.ts',
    '#EXTINF:5.005,',
    '#EXT-X-BYTERANGE:2048@1024',
    'all.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const media = parseMediaPlaylist(text, 'https://cdn.example/hls/index.m3u8');
  assert.equal(media.segments.length, 2);
  assert.equal(media.endList, true);
  assert.equal(media.segments[1]?.url, 'https://cdn.example/hls/all.ts');
  assert.deepEqual(media.segments[1]?.byteRange, { length: 2048, offset: 1024 });
  assert.equal(media.segments[0]?.key?.url, 'https://cdn.example/hls/key.bin');
  assert.equal(media.segments[1]?.key?.iv?.toString('hex'), '00000000000000000000000000000001');
});

test('the spool can be read while it is still being written', async () => {
  const dir = tempDir();
  const spool = new StreamSpool(path.join(dir, 'uploads'), 'spool-1', 'ts');
  // The writer runs in the background on purpose, but it is kept as a promise so
  // the test can wait for it before `remove()` closes the spool: a finish() that
  // landed after cleanup would close a descriptor number that by then belonged
  // to the next test's spool, which is what made this file flaky.
  const writer = (async () => {
    for (let index = 0; index < 5; index += 1) {
      await spool.append(Buffer.from(`chunk-${index};`));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await spool.finish();
  })();

  try {
    // The reader starts before the writer is finished and still gets everything.
    const head = await spool.read(0, 8);
    assert.equal(head.toString(), 'chunk-0;');
    await spool.waitFor(40);
    const whole = await spool.read(0, 100);
    assert.equal(whole.toString(), 'chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;');
  } finally {
    // Nothing may still be writing to the spool when it is removed.
    await writer;
    spool.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a relay serves the bytes that exist, not the sizes the playlist promised', async () => {
  const dir = tempDir();
  const spool = new StreamSpool(path.join(dir, 'uploads'), 'spool-mismatch', 'ts');
  const relay = new RelayHub();
  const server = await startRelayServer(relay);
  try {
    // The sizing step measured 10 + 20 bytes of ciphertext; the downloader really
    // produced 7 + 12 after AES padding was stripped. Serving the measured spans
    // would leave Bunny waiting for bytes that never come, which is exactly how a
    // real pull ends in Bunny's own “upload failed”.
    const first = Buffer.from('first!!');
    const second = Buffer.from('second-seg!!');
    const token = relay.register({
      jobId: 'job-mismatch',
      label: 'Bunny Publisher 1080p',
      spool,
      segments: [
        { duration: 4, offset: 0, bytes: 10 },
        { duration: 4, offset: 10, bytes: 20 },
      ],
      totalBytes: 30,
      extension: 'ts',
      contentType: 'video/mp2t',
    });
    const writer = (async () => {
      for (const part of [first, second]) {
        await spool.appendSegment(part);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await spool.finish();
    })();

    // While the download is still running each segment is answered at its real
    // length — a request for one that has not arrived yet waits for it.
    for (const [index, expected] of [first, second].entries()) {
      const response = await fetch(`${server.url}/relay/${token}/seg/${index}.ts`);
      assert.equal(response.status, 200);
      assert.equal(Number(response.headers.get('content-length')), expected.length, `segment ${index} must declare its real length`);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(expected), `segment ${index} must be the downloaded bytes`);
    }
    await writer;

    // The whole-file path (a direct source) is only as long as what was downloaded.
    const file = await fetch(`${server.url}/relay/${token}/stream.ts`);
    assert.equal(Number(file.headers.get('content-length')), first.length + second.length);
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(Buffer.concat([first, second])));

    relay.release(token);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the floor walks past a source that cannot reach it', async () => {
  const origin = await startOrigin();
  try {
    // Two candidates of the same title: a 720p host and a 1080p host. The 720p
    // one is probed first and must be walked past, not settled on.
    const choice = await chooseCandidate(
      [
        { provider: 'Movy', quality: '720p', url: `${origin.url}/v720/index.m3u8`, height: 720 },
        { provider: 'Rigel', quality: '1080p', url: `${origin.url}/v1080/index.m3u8`, height: 1080 },
      ],
      { floor: 1080 },
    );
    assert.equal(choice.probe.height, 1080);
    assert.equal(choice.probe.provider, 'Rigel');
    assert.equal(choice.belowFloor, false);
    assert.equal(choice.candidates.find((candidate) => candidate.chosen)?.provider, 'Rigel');
  } finally {
    await origin.close();
  }
});

test('a source below the floor is still used, and the job says why', async () => {
  const origin = await startOrigin();
  try {
    const choice = await chooseCandidate(
      [{ provider: 'Movy', quality: '720p', url: `${origin.url}/v720/index.m3u8`, height: 720 }],
      { floor: 1080 },
    );
    assert.equal(choice.probe.height, 720);
    assert.equal(choice.belowFloor, true);
    assert.match(choice.note, /no source reached 1080p/);
  } finally {
    await origin.close();
  }
});

test('Bunny pulls the stream through the tunnel while it is still downloading', async () => {
  const origin = await startOrigin({ delayMs: 60 });
  const dir = tempDir();
  const config = testConfig(dir, { streamConcurrency: 2 });
  const store = new Store(config);
  const relay = new RelayHub();
  const relayServer = await startRelayServer(relay);
  const tunnel = new TunnelManager({ root: dir, port: 0, enabled: true, allowDownload: false, externalUrl: relayServer.url });

  const seen: { url: string; bytes: number; segments: number; lengthsExact: boolean; intact: boolean }[] = [];
  const fakeBunny = {
    // Bunny's fetcher follows the HLS ladder the relay publishes: master
    // playlist → media playlist → one request per segment, each answered at its
    // real byte length. This is what lets a pull survive a source whose measured
    // sizes were never the truth (AES padding, a CDN that lies).
    async fetchFromUrl(url: string) {
      const master = await fetch(url);
      assert.equal(master.status, 200);
      const masterText = await master.text();
      assert.match(masterText, /#EXT-X-STREAM-INF:BANDWIDTH=\d+/);
      assert.match(masterText, /NAME="Bunny Publisher 1080p"/);
      const playlistPath = masterText.split('\n').find((line) => line.startsWith('playlist'));
      assert.ok(playlistPath, 'the master playlist must point at a media playlist');
      const playlistUrl = new URL(playlistPath, url);
      const playlist = await fetch(playlistUrl);
      assert.equal(playlist.status, 200);
      const segmentPaths = (await playlist.text()).split('\n').filter((line) => line.startsWith('seg/'));
      assert.ok(segmentPaths.length > 0, 'the media playlist must list segments');
      const parts: Buffer[] = [];
      let lengthsExact = true;
      for (const segmentPath of segmentPaths) {
        const response = await fetch(new URL(segmentPath, playlistUrl));
        assert.equal(response.status, 200);
        const body = Buffer.from(await response.arrayBuffer());
        if (Number(response.headers.get('content-length') ?? -1) !== body.length) lengthsExact = false;
        parts.push(body);
      }
      const body = Buffer.concat(parts);
      seen.push({ url, bytes: body.length, segments: segmentPaths.length, lengthsExact, intact: body.equals(origin.expected) });
      return { success: true, statusCode: 200 };
    },
    async uploadVideoResumable() {
      throw new Error('the tunnel transport must not fall back to an upload');
    },
  } as unknown as BunnyClient;

  const job = store.addJob({
    id: 'job-tunnel',
    target: { kind: 'movie', tmdbId: 27205, title: 'Inception' },
    source: { kind: 'stream', mode: 'source', name: 'pasted.m3u8', input: origin.masterUrl },
    status: 'uploading',
    progress: 0,
    polls: 0,
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const spoolPath = path.join(config.uploadsDir, `${job.id}.ts`);

  let created = 0;
  try {
    const result = await runStreamJob(
      job.id,
      { config, store, relay, tunnel, log: () => undefined },
      { update: (patch) => void store.updateJob(job.id, patch), isRunning: () => true },
      {
        title: 'Inception',
        client: fakeBunny,
        ensureVideo: async () => {
          created += 1;
          store.updateJob(job.id, { bunnyVideoId: 'ours' });
          return 'ours';
        },
        adoptFetchedVideo: async () => 'bunny-made-this',
      },
    );

    assert.equal(result.transport, 'tunnel');
    assert.equal(created, 0, 'a Bunny-side fetch must not create a video object of its own');
    assert.equal(store.job(job.id)?.bunnyVideoId, 'bunny-made-this', 'the job adopts the video Bunny created');
    assert.equal(result.quality, '1080p');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.bytes, origin.expected.length, 'Bunny must receive the whole stream');
    assert.equal(seen[0]?.intact, true, 'the segments Bunny pulled must be the source stream, byte for byte');
    assert.equal(seen[0]?.segments, 4, 'the fetch must follow the playlist, segment by segment');
    assert.equal(seen[0]?.lengthsExact, true, 'every segment must declare its real length');

    // The segment the relay served is byte-identical to what the origin published.
    const streamedBack = await fetch(`${relayServer.url}/relay/${result.relayToken}/stream.ts`);
    const relayed = Buffer.from(await streamedBack.arrayBuffer());
    assert.equal(relayed.length, origin.expected.length);
    assert.ok(relayed.equals(origin.expected), 'the relay bytes must match the source stream');

    const playlist = await fetch(`${relayServer.url}/relay/${result.relayToken}/playlist.m3u8`);
    const playlistText = await playlist.text();
    assert.match(playlistText, /#EXT-X-ENDLIST/);
    assert.equal((playlistText.match(/^seg\//gm) ?? []).length, 4);

    // While the tunnel transport is live the spool stays: Bunny is still reading it.
    assert.equal(fs.existsSync(spoolPath), true);
    assert.equal(store.job(job.id)?.relayToken, result.relayToken);
    relay.release(result.relayToken);
    assert.equal(fs.existsSync(spoolPath), false, 'releasing the relay deletes the spool');
  } finally {
    relay.release(store.job(job.id)?.relayToken);
    await relayServer.close();
    await origin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a tunnel the dashboard uploads the bytes itself, as they arrive', async () => {
  const origin = await startOrigin({ delayMs: 40 });
  const dir = tempDir();
  const config = testConfig(dir, { streamConcurrency: 1, tusChunkBytes: 16 * 1024 });
  const store = new Store(config);
  const relay = new RelayHub();
  // No public URL and no cloudflared: the pipeline must fall back on its own.
  const tunnel = new TunnelManager({ root: dir, port: 0, enabled: false, allowDownload: false });

  const chunks: number[] = [];
  let bytesAtFirstRead = -1;
  let created = 0;
  const fakeBunny = {
    async fetchFromUrl() {
      return { success: false, message: 'no tunnel in this test' };
    },
    async uploadVideoResumable(
      _videoId: string,
      _filePath: undefined,
      options: {
        source: { totalBytes: number; read(offset: number, length: number): Promise<Buffer> };
        fileName?: string;
        onProgress?: (sent: number, total: number) => void;
      },
    ) {
      let offset = 0;
      const parts: Buffer[] = [];
      while (offset < options.source.totalBytes) {
        const chunk = await options.source.read(offset, 16 * 1024);
        if (bytesAtFirstRead === -1) bytesAtFirstRead = store.job('job-direct')?.bytesIn ?? -1;
        chunks.push(chunk.length);
        parts.push(chunk);
        offset += chunk.length;
        options.onProgress?.(offset, options.source.totalBytes);
      }
      const uploaded = Buffer.concat(parts);
      assert.ok(uploaded.equals(origin.expected), 'the uploaded bytes must be the stream');
      return { uploadUrl: 'mock://tus', bytesSent: offset, totalBytes: options.source.totalBytes, resumed: false };
    },
  } as unknown as BunnyClient;

  store.addJob({
    id: 'job-direct',
    target: { kind: 'movie', tmdbId: 27205, title: 'Inception' },
    source: { kind: 'stream', mode: 'source', name: 'pasted.m3u8', input: origin.masterUrl },
    status: 'uploading',
    progress: 0,
    polls: 0,
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const spoolPath = path.join(config.uploadsDir, 'job-direct.ts');

  try {
    const result = await runStreamJob(
      'job-direct',
      { config, store, relay, tunnel, log: () => undefined },
      { update: (patch) => void store.updateJob('job-direct', patch), isRunning: () => true },
      {
        title: 'Inception',
        client: fakeBunny,
        ensureVideo: async () => {
          created += 1;
          store.updateJob('job-direct', { bunnyVideoId: 'ours' });
          return 'ours';
        },
        adoptFetchedVideo: async () => {
          throw new Error('the direct transport must not adopt a fetched video');
        },
      },
    );
    assert.equal(result.transport, 'direct');
    assert.equal(created, 1, 'the direct transport creates exactly one video object');
    assert.equal(result.bytes, origin.expected.length);
    assert.ok(chunks.length > 1, 'the upload must go out in several chunks');
    assert.ok(
      bytesAtFirstRead < origin.expected.length,
      `the upload must start before the download ends (downloaded ${bytesAtFirstRead} of ${origin.expected.length})`,
    );
    const job = store.job('job-direct');
    assert.equal(job?.bytesOut, origin.expected.length);
    assert.equal(job?.relayToken, undefined, 'the relay is released once the upload is done');
    assert.equal(fs.existsSync(spoolPath), false, 'the spool is deleted after a direct upload');
  } finally {
    await origin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
