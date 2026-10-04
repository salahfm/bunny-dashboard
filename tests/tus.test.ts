import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TusError,
  TusUploadAborted,
  guessVideoContentType,
  parseUploadOffset,
  tusAuthHeaders,
  tusMetadata,
  tusSignature,
  tusUpload,
  type TusUploadOptions,
} from '../src/tus';
import { FakeTusServer } from './fake-tus';

/** No real waiting and no back-off in tests. */
const fastRetries = { retryDelaysMs: [0, 0, 0], sleep: async () => undefined };
const CHUNK = 64 * 1024;

function tempMovie(bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'));
  const file = path.join(dir, 'movie.mp4');
  const data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) data[index] = (index * 31 + 7) % 251;
  fs.writeFileSync(file, data);
  return file;
}

function options(server: FakeTusServer, filePath: string, chunkBytes = CHUNK): TusUploadOptions {
  return {
    libraryId: '456',
    apiKey: 'secret-key',
    videoId: 'video-guid-1',
    filePath,
    title: 'Movie',
    endpoint: server.endpoint,
    chunkBytes,
    fetchImpl: server.handler as unknown as typeof fetch,
    now: () => 1_700_000_000_000,
    ...fastRetries,
  };
}

test('the signature matches the SHA256(libraryId + apiKey + expire + videoId) rule', () => {
  const auth = { libraryId: '456', apiKey: 'secret-key', videoId: 'abc-123' };
  const expected = crypto.createHash('sha256').update('456secret-key1700000000abc-123').digest('hex');
  assert.equal(tusSignature(auth, 1_700_000_000), expected);

  const headers = tusAuthHeaders(auth, 1_700_000_000_000);
  assert.equal(headers.AuthorizationExpire, '1700086400');
  assert.equal(headers.LibraryId, '456');
  assert.equal(headers.VideoId, 'abc-123');
  assert.equal(headers.AuthorizationSignature, tusSignature(auth, 1_700_086_400));
});

test('metadata and file names are encoded the way Bunny expects', () => {
  assert.equal(
    tusMetadata({ filetype: 'video/mp4', title: 'Breaking Bad S01E01', collection: undefined, empty: '' }),
    `filetype ${Buffer.from('video/mp4').toString('base64')},title ${Buffer.from('Breaking Bad S01E01').toString('base64')}`,
  );
  assert.equal(guessVideoContentType('movie.MKV'), 'video/x-matroska');
  assert.equal(guessVideoContentType('clip.mp4'), 'video/mp4');
  assert.equal(guessVideoContentType('mystery'), 'application/octet-stream');
  assert.equal(parseUploadOffset('4096'), 4096);
  assert.equal(parseUploadOffset(undefined), undefined);
  assert.equal(parseUploadOffset('nonsense'), undefined);
});

test('a file uploads in chunks and lands byte-for-byte', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(4 * CHUNK);
  const progress: Array<[number, number]> = [];
  const urls: string[] = [];

  const result = await tusUpload({
    ...options(server, file),
    onProgress: (sent, total) => progress.push([sent, total]),
    onUploadUrl: (url) => urls.push(url),
  });

  assert.equal(server.creations, 1);
  assert.equal(server.posts, 1);
  assert.deepEqual(
    server.patches.map((patch) => patch.offset),
    [0, CHUNK, 2 * CHUNK, 3 * CHUNK],
  );
  assert.equal(result.bytesSent, 4 * CHUNK);
  assert.equal(result.resumed, false);
  assert.equal(urls.length, 1);
  assert.ok(urls[0]?.startsWith(`${server.endpoint}/`), `relative Location must resolve: ${urls[0]}`);
  assert.deepEqual(progress.at(-1), [4 * CHUNK, 4 * CHUNK]);

  const resource = server.onlyResource();
  assert.ok(resource.stored.equals(fs.readFileSync(file)), 'the stored bytes must match the file');

  const post = server.lastPostHeaders;
  assert.equal(post['tus-resumable'], '1.0.0');
  assert.equal(post['upload-length'], String(4 * CHUNK));
  assert.equal(post.videoid, 'video-guid-1');
  assert.equal(post.libraryid, '456');
  assert.equal(post.authorizationsignature, tusSignature({ libraryId: '456', apiKey: 'secret-key', videoId: 'video-guid-1' }, Number(post.authorizationexpire)));
  const metadata = Object.fromEntries(
    (post['upload-metadata'] ?? '').split(',').map((pair) => {
      const [key, value] = pair.split(' ');
      return [key, Buffer.from(value ?? '', 'base64').toString('utf8')];
    }),
  );
  assert.deepEqual(metadata, { filetype: 'video/mp4', title: 'Movie' });
});

test('a dropped connection is retried until the file is complete', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(3 * CHUNK);
  server.failNextPatches = 2;

  const result = await tusUpload(options(server, file));

  assert.equal(result.bytesSent, 3 * CHUNK);
  assert.equal(server.patches.length, 3, 'the three chunks the server accepted');
  assert.equal(server.patchAttempts, 5, 'three chunks plus two replayed ones');
  assert.equal(server.heads, 2, 'each failure re-reads the offset with HEAD');
  assert.deepEqual(
    server.patches.map((patch) => patch.offset),
    [0, CHUNK, 2 * CHUNK],
  );
  assert.ok(server.onlyResource().stored.equals(fs.readFileSync(file)));
});

test('a chunk that only half-lands resumes from the offset Bunny reports', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(2.5 * CHUNK);
  server.dropNextChunkBytes = 20 * 1024;

  const result = await tusUpload(options(server, file));

  assert.equal(result.bytesSent, 2.5 * CHUNK);
  assert.deepEqual(
    server.patches.map((patch) => patch.offset),
    [20 * 1024, 84 * 1024, 148 * 1024],
  );
  assert.ok(server.onlyResource().stored.equals(fs.readFileSync(file)));
});

test('a saved upload URL resumes a partial upload instead of restarting it', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(4 * CHUNK);
  server.failPatchesAfter = 2;

  await assert.rejects(tusUpload(options(server, file)), (error: unknown) => error instanceof TusError && /gave up at byte 131072/.test(error.message));
  const resource = server.onlyResource();
  const offsetBefore = resource.offset;
  assert.equal(offsetBefore, 2 * CHUNK);
  assert.equal(server.creations, 1);
  assert.equal(server.patches.length, 2);

  server.failPatchesAfter = Number.POSITIVE_INFINITY;
  const result = await tusUpload({ ...options(server, file), resumeUrl: `${server.endpoint}/${resource.id}` });

  assert.equal(server.creations, 1, 'a resume must not create a second session');
  assert.equal(server.posts, 1);
  assert.equal(result.resumed, true);
  assert.equal(result.bytesSent, 4 * CHUNK);
  assert.equal(server.patches[2]?.offset, offsetBefore);
  assert.ok(resource.stored.equals(fs.readFileSync(file)), 'the resumed upload must not duplicate or skip bytes');
});

test('an unknown saved upload URL quietly starts a fresh session', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(CHUNK);

  const result = await tusUpload({ ...options(server, file), resumeUrl: `${server.endpoint}/expired-session` });

  assert.equal(result.resumed, false);
  assert.equal(result.bytesSent, CHUNK);
  assert.equal(server.creations, 1);
  assert.ok(server.onlyResource().stored.equals(fs.readFileSync(file)));
});

test('cancellation stops the upload between chunks', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(4 * CHUNK);
  const uploadedSoFar = () => (server.resources.size === 0 ? 0 : server.onlyResource().offset);

  await assert.rejects(
    tusUpload({ ...options(server, file), shouldContinue: () => uploadedSoFar() < 2 * CHUNK }),
    (error: unknown) => error instanceof TusUploadAborted,
  );

  assert.equal(server.patches.length, 2);
  assert.equal(server.onlyResource().offset, 2 * CHUNK);
});

test('the uploader talks TUS over a real HTTP connection', async () => {
  const sessions = new Map<string, { length: number; stored: Buffer; offset: number }>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/tusupload') {
      const length = Number(request.headers['upload-length'] ?? 0);
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, { length, stored: Buffer.alloc(length), offset: 0 });
      response.writeHead(201, { Location: `/tusupload/${id}`, 'Upload-Offset': '0', 'Tus-Resumable': '1.0.0' });
      response.end();
      return;
    }
    const session = sessions.get(url.pathname.split('/').pop() ?? '');
    if (!session) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Upload-Offset': String(session.offset), 'Upload-Length': String(session.length), 'Tus-Resumable': '1.0.0' });
      response.end();
      return;
    }
    if (request.method === 'PATCH') {
      const offset = Number(request.headers['upload-offset']);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        if (offset !== session.offset) {
          response.writeHead(409);
          response.end();
          return;
        }
        body.copy(session.stored, offset);
        session.offset += body.length;
        response.writeHead(204, { 'Upload-Offset': String(session.offset), 'Tus-Resumable': '1.0.0' });
        response.end();
      });
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const file = tempMovie(3 * CHUNK);
    const result = await tusUpload({
      libraryId: '456',
      apiKey: 'secret-key',
      videoId: 'video-guid-1',
      filePath: file,
      title: 'Movie',
      chunkBytes: CHUNK,
      endpoint: `http://127.0.0.1:${port}/tusupload`,
      now: () => 1_700_000_000_000,
      ...fastRetries,
    });

    assert.equal(result.bytesSent, 3 * CHUNK);
    assert.equal(sessions.size, 1);
    const [session] = [...sessions.values()];
    assert.ok(session?.stored.equals(fs.readFileSync(file)), 'the bytes that crossed the socket must match the file');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a missing video (404 when creating the session) surfaces with its status', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(8 * 1024);
  server.createStatus = 404;

  await assert.rejects(tusUpload(options(server, file)), (error: unknown) => error instanceof TusError && error.status === 404);
  assert.equal(server.posts, 1);
});

test('a rejected key (401) is not retried', async () => {
  const server = new FakeTusServer();
  const file = tempMovie(8 * 1024);
  server.createStatus = 401;

  await assert.rejects(tusUpload(options(server, file)), (error: unknown) => error instanceof TusError && error.status === 401);
  assert.equal(server.posts, 1, 'authorization failures must fail fast');
});
