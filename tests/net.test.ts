/**
 * The outbound fetch policy.
 *
 * The failure this exists for is the one that produced a bare `fetch failed` on
 * a real job: a connection that hangs, an attempt with no deadline, an error with
 * no host in it. Each test below pins one of those three.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NetworkError, checkReachability, fetchWithPolicy } from '../src/net';

function countingFetch(handler: (attempt: number, init: RequestInit) => Promise<Response>) {
  let attempts = 0;
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    return handler(attempts, init ?? {});
  }) as typeof fetch;
  return { impl, attempts: () => attempts };
}

/** Rejects when the caller's signal aborts, the way a real fetch does. */
function hangingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      const fail = () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail, { once: true });
    })) as typeof fetch;
}

test('a dropped connection is retried and the call still succeeds', async () => {
  const { impl, attempts } = countingFetch(async (attempt) => {
    if (attempt < 3) {
      const error = new Error('socket hang up');
      (error as { cause?: unknown }).cause = { code: 'ECONNRESET' };
      throw error;
    }
    return new Response('{"ok":true}', { status: 200 });
  });

  const response = await fetchWithPolicy('https://example.test/thing', {}, { fetchImpl: impl, retries: 3, backoffMs: 1 });
  assert.equal(response.status, 200);
  assert.equal(attempts(), 3);
});

test('a 503 is retried, a 401 is an answer', async () => {
  const server = countingFetch(async (attempt) => new Response('nope', { status: attempt === 1 ? 503 : 401 }));
  const response = await fetchWithPolicy('https://example.test/thing', {}, { fetchImpl: server.impl, retries: 2, backoffMs: 1 });
  assert.equal(response.status, 401);
  assert.equal(server.attempts(), 2, 'the 503 was retried, the 401 was returned as-is');

  const denied = countingFetch(async () => new Response('denied', { status: 401 }));
  const first = await fetchWithPolicy('https://example.test/thing', {}, { fetchImpl: denied.impl, retries: 3, backoffMs: 1 });
  assert.equal(first.status, 401);
  assert.equal(denied.attempts(), 1);
});

test('a hung attempt is cut off and reported with the host, the time and a hint', async () => {
  const impl = hangingFetch();
  const started = Date.now();
  await assert.rejects(
    fetchWithPolicy('https://video.bunnycdn.com/library/1/videos', {}, { fetchImpl: impl, timeoutMs: 120, retries: 1, backoffMs: 1, what: 'the Bunny API' }),
    (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.timedOut, true);
      assert.equal(error.host, 'video.bunnycdn.com');
      assert.equal(error.attempts, 2);
      assert.match(error.message, /the Bunny API could not be reached after 2 attempt\(s\)/);
      assert.match(error.message, /no answer within 1s|no answer within 0s/);
      assert.match(error.message, /network path to video\.bunnycdn\.com is not answering/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000, 'two 120 ms attempts must not take seconds');
});

test('reachability reports a live host with its latency, and a dead port with the reason', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const live = await checkReachability('local', `http://127.0.0.1:${port}/`, { timeoutMs: 2_000 });
    assert.equal(live.ok, true);
    assert.equal(live.status, 200);
    assert.ok(live.ms >= 0);
    assert.equal(live.host, `127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const dead = await checkReachability('dead', 'http://127.0.0.1:1/', { timeoutMs: 2_000 });
  assert.equal(dead.ok, false);
  assert.ok((dead.error ?? '').length > 0, 'a refused connection must say something');
});
