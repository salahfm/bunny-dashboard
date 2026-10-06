import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BunnyClient, BunnyError, mapBunnyStatus, playbackUrlFor } from '../src/bunny';
import { tusSignature } from '../src/tus';
import { FakeTusServer } from './fake-tus';

interface FakeResponse {
  status?: number;
  body?: unknown;
}

function captureFetch(handler: (url: string, init: RequestInit) => FakeResponse) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    const result = handler(url, requestInit);
    const status = result.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test('status mapping matches Bunny Stream codes', () => {
  assert.equal(mapBunnyStatus(0), 'active');
  assert.equal(mapBunnyStatus(3), 'active');
  assert.equal(mapBunnyStatus(4), 'ready');
  assert.equal(mapBunnyStatus(8), 'ready');
  assert.equal(mapBunnyStatus(5), 'failed');
  assert.equal(mapBunnyStatus(6), 'failed');
});

test('playback URLs are built from the pull-zone host', () => {
  assert.equal(playbackUrlFor('vz-abc.b-cdn.net', 'guid-1'), 'https://vz-abc.b-cdn.net/guid-1/playlist.m3u8');
  assert.equal(playbackUrlFor('https://vz-abc.b-cdn.net/', 'guid-1'), 'https://vz-abc.b-cdn.net/guid-1/playlist.m3u8');
  assert.equal(playbackUrlFor(undefined, 'guid-1'), undefined);
  assert.equal(playbackUrlFor('  ', 'guid-1'), undefined);
});

test('createVideo posts the title with the AccessKey header', async () => {
  const { impl, calls } = captureFetch(() => ({ body: { guid: 'v1', title: 'Test', status: 0, encodeProgress: 0, length: 0 } }));
  const client = new BunnyClient({ apiKey: 'key-123', libraryId: '456', fetchImpl: impl });
  const video = await client.createVideo('Test');
  assert.equal(video.guid, 'v1');
  assert.equal(calls[0]?.url, 'https://video.bunnycdn.com/library/456/videos');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal((calls[0]?.init.headers as Record<string, string>).AccessKey, 'key-123');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { title: 'Test' });
});

test('fetchFromUrl posts the remote URL to the fetch endpoint', async () => {
  const { impl, calls } = captureFetch(() => ({ body: { success: true, statusCode: 200 } }));
  const client = new BunnyClient({ apiKey: 'key-123', libraryId: '456', fetchImpl: impl });
  const result = await client.fetchFromUrl('https://example.com/movie.mp4', 'Movie');
  assert.equal(result.success, true);
  assert.equal(calls[0]?.url, 'https://video.bunnycdn.com/library/456/videos/fetch');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { url: 'https://example.com/movie.mp4', title: 'Movie' });
});

test('an unauthorized response surfaces as BunnyError with its status', async () => {
  const { impl } = captureFetch(() => ({ status: 401, body: { message: 'Unauthorized' } }));
  const client = new BunnyClient({ apiKey: 'bad', libraryId: '456', fetchImpl: impl });
  await assert.rejects(client.createVideo('x'), (error: unknown) => error instanceof BunnyError && error.status === 401);
});

test('uploadVideoResumable drives Bunny’s TUS endpoint with signed headers', async () => {
  const server = new FakeTusServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-tus-'));
  const file = path.join(dir, 'clip.mp4');
  const size = 4 * 64 * 1024;
  fs.writeFileSync(file, Buffer.alloc(size, 5));
  const client = new BunnyClient({ apiKey: 'key-123', libraryId: '456', fetchImpl: server.handler as unknown as typeof fetch });

  const result = await client.uploadVideoResumable('v1', file, { title: 'Clip', chunkBytes: 64 * 1024 });

  assert.equal(result.bytesSent, size);
  assert.equal(result.resumed, false);
  assert.equal(server.patches.length, 4);
  assert.ok(server.onlyResource().stored.equals(fs.readFileSync(file)));
  const headers = server.lastPostHeaders;
  assert.equal(headers['tus-resumable'], '1.0.0');
  assert.equal(headers['upload-length'], String(size));
  assert.equal(headers['upload-metadata'], `filetype ${Buffer.from('video/mp4').toString('base64')},title ${Buffer.from('Clip').toString('base64')}`);
  assert.equal(headers.libraryid, '456');
  assert.equal(headers.videoid, 'v1');
  assert.equal(headers.authorizationsignature, tusSignature({ libraryId: '456', apiKey: 'key-123', videoId: 'v1' }, Number(headers.authorizationexpire)));
});

test('a TUS failure surfaces as BunnyError with its status', async () => {
  const server = new FakeTusServer();
  server.createStatus = 404;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-tus-gone-'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(1024, 5));
  const client = new BunnyClient({ apiKey: 'key-123', libraryId: '456', fetchImpl: server.handler as unknown as typeof fetch });

  await assert.rejects(client.uploadVideoResumable('v1', file, { title: 'Clip' }), (error: unknown) => error instanceof BunnyError && error.status === 404);
});

test('uploadVideo streams the file with an explicit byte length', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-upload-'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(1024, 1));
  let seenLength: string | undefined;
  let drained = false;
  const { impl, calls } = captureFetch((_url, init) => {
    const headers = init.headers as Record<string, string>;
    seenLength = headers['content-length'];
    const body = init.body as { resume?: () => void } | undefined;
    if (body && typeof body.resume === 'function') {
      body.resume();
      drained = true;
    }
    return { body: { success: true } };
  });
  const client = new BunnyClient({ apiKey: 'key', libraryId: '9', fetchImpl: impl });
  await client.uploadVideo('v1', file);
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.url, 'https://video.bunnycdn.com/library/9/videos/v1');
  assert.equal(seenLength, '1024');
  assert.equal(drained, true);
});

test('uploadVideoStream puts a byte source on the wire, with a declared length', async () => {
  const payload = Buffer.from(Array.from({ length: 900 }, (_, index) => index % 253));
  let seenLength: string | undefined;
  let body: Buffer | undefined;
  let drained: Promise<void> = Promise.resolve();
  const { impl, calls } = captureFetch((_url, init) => {
    seenLength = (init.headers as Record<string, string>)['content-length'];
    // Nobody else will read the request body, so this test has to pull it dry
    // itself — which is also proof the bytes come off the source on demand.
    drained = (async () => {
      const chunks: Buffer[] = [];
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks);
    })();
    return { body: { success: true } };
  });
  const reads: Array<{ offset: number; length: number }> = [];
  const client = new BunnyClient({ apiKey: 'key', libraryId: '9', fetchImpl: impl });
  await client.uploadVideoStream('v1', {
    totalBytes: payload.length,
    read: async (offset: number, length: number) => {
      reads.push({ offset, length });
      return payload.subarray(offset, offset + length);
    },
  });
  await drained;

  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(calls[0]?.url, 'https://video.bunnycdn.com/library/9/videos/v1');
  assert.equal(seenLength, String(payload.length));
  assert.equal((calls[0]?.init as { duplex?: string }).duplex, 'half');
  assert.deepEqual(body, payload);
  // Read strictly forwards, so the bytes are never held anywhere but in flight.
  assert.deepEqual(reads[0], { offset: 0, length: payload.length });
});
