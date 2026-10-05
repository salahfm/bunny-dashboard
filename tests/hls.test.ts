import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StreamSpool, downloadSegments, type HlsSegment } from '../src/hls';
import { probeCandidate } from '../src/stream';

/**
 * The window keeps several segments in flight, but only the awaited one has a
 * handler attached. A later segment failing used to surface as an unhandled
 * rejection — which Node ends the process over — instead of failing the job.
 */
test('a failing segment settles the rest of the download window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-hls-'));
  const spool = new StreamSpool(dir, 'job', 'ts');
  // Nothing listens on port 1, so every fetch is refused at once.
  const segments: HlsSegment[] = Array.from({ length: 4 }, (_, index) => ({
    url: `http://127.0.0.1:1/seg${index}.ts`,
    duration: 1,
    index,
  }));

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(() => downloadSegments(segments, spool, { concurrency: 4, attempts: 1 }));
    // Give a leaked rejection a chance to fire before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    spool.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(unhandled.length, 0, 'no in-flight segment may be left without a handler');
  assert.ok(spool.failed, 'the spool records why the download died');
});

/**
 * HEAD is not universal: plenty of CDNs answer 405 for it. Probing with a
 * one-byte range instead of giving up is the difference between a usable source
 * and a job that reports "every source we tried was unusable".
 */
test('a source that refuses HEAD is probed with a ranged GET', async () => {
  const server = http.createServer((req, res) => {
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      res.statusCode = 405;
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('content-range', 'bytes 0-0/2048');
    res.setHeader('content-length', '1');
    res.end(Buffer.from([0]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const probe = await probeCandidate({
      provider: 'Test',
      quality: 'Auto',
      url: `http://127.0.0.1:${port}/movie.mp4`,
      height: 0,
    });
    assert.equal(probe.directFile, true, 'the ranged answer marks it a plain file');
    assert.equal(probe.totalBytes, 2048, 'the size comes from Content-Range');
  } finally {
    server.close();
  }
});
