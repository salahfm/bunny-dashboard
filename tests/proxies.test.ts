/**
 * The scrape proxy pool.
 *
 * The failure this exists for: a machine that scrapes the same hosts often gets
 * its *address* blocked, and then every request fails however politely it is
 * asked — `HTTP 403`, or a bot wall, forever. Each test below pins one of the
 * answers: the list is read correctly, requests spread over it, an exit the host
 * refused is skipped instead of being blamed on the host, an exit the *proxy*
 * refused is dropped, and the metered exits never carry a download.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import { HostGuard } from '../src/hostguard';
import { configureScraper, fetchText, fetchWithTimeout } from '../src/providers';
import {
  BUILT_IN_PROXIES,
  ProxyPool,
  builtInProxies,
  closeDispatchers,
  countBytes,
  isProxyRefusal,
  parseProxyEntry,
  parseProxyList,
  readProxyFailure,
  testExits,
} from '../src/proxies';
import { FAKE_PROXY_AUTHORIZATION, startFakeProxy } from './support/fake-proxy';

/**
 * A host of our own: records what it was asked for — and through which exit, when
 * the request came through a proxy — and answers what the test tells it to.
 */
async function startOrigin(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Array<{ path: string; via?: string }> = [];
  const server = http.createServer((req, res) => {
    const via = req.headers['x-fake-proxy'];
    seen.push({ path: req.url ?? '', ...(typeof via === 'string' ? { via } : {}) });
    if (handler) {
      handler(req, res);
      return;
    }
    if ((req.url ?? '').endsWith('.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>ok</html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Nothing a test does may leave a pool wired into the scraper for the next one. */
function releaseScraper(): void {
  configureScraper({ proxies: new ProxyPool([]) });
}

test('a proxy line is read in every shape a provider exports', () => {
  const exported = parseProxyEntry('31.59.20.176:6754:sydblqor:9hgn1ml1w4kp');
  assert.equal(exported?.host, '31.59.20.176');
  assert.equal(exported?.port, 6754);
  assert.equal(exported?.username, 'sydblqor');
  assert.equal(exported?.password, '9hgn1ml1w4kp');
  assert.equal(exported?.url, 'http://sydblqor:9hgn1ml1w4kp@31.59.20.176:6754');
  assert.equal(exported?.label, 'sydblqor@31.59.20.176:6754');

  assert.equal(parseProxyEntry('sydblqor:9hgn1ml1w4kp@31.59.20.176:6754')?.url, exported?.url);
  assert.equal(parseProxyEntry('http://sydblqor:9hgn1ml1w4kp@31.59.20.176:6754')?.url, exported?.url);

  assert.equal(parseProxyEntry(''), undefined);
  assert.equal(parseProxyEntry('# the exports, again'), undefined);
  assert.equal(parseProxyEntry('31.59.20.176:6754:sydblqor'), undefined, 'a half-read line is skipped, never guessed at');
  assert.equal(parseProxyEntry('31.59.20.176:0:sydblqor:pass'), undefined, 'a port that is not a port');
  assert.equal(parseProxyEntry('31.59.20.176:port:sydblqor:pass'), undefined);
  assert.equal(parseProxyEntry('31.59.20.176:6754::pass'), undefined, 'no user is not a usable exit');
});

test('the built-in list parses whole, and every exit is named apart', () => {
  const proxies = builtInProxies();
  assert.equal(proxies.length, BUILT_IN_PROXIES.length);
  assert.equal(proxies.length, 90, 'nine credential sets over ten addresses');
  assert.equal(new Set(proxies.map((entry) => entry.label)).size, 90, 'two sets on one address must not collide');
  assert.equal(new Set(proxies.map((entry) => entry.host)).size, 10);
  assert.ok(proxies.every((entry) => entry.url.startsWith('http://') && entry.port > 0));

  assert.equal(parseProxyList('user:pass@h.test:1, user:pass@h.test:1\nother:pass@h.test:2').length, 2, 'the same exit twice is one exit');
  assert.deepEqual(parseProxyList('nonsense').length, 0);
  assert.deepEqual(parseProxyList(undefined).length, 0);
});

test('the pool spreads requests over the exits, and skips the ones sitting out', () => {
  let now = 1_000;
  const pool = new ProxyPool(builtInProxies().slice(0, 3), { now: () => now, blockedCooldownMs: 5_000 });

  const first = pool.pick();
  const second = pool.pick();
  const third = pool.pick();
  assert.ok(first && second && third);
  assert.equal(new Set([first.label, second.label, third.label]).size, 3, 'three requests, three different exits');
  assert.equal(pool.pick()?.label, first.label, 'the fourth request comes back round to the first');

  const blocked = pool.report(second, 'blocked', 'HTTP 403');
  void blocked;
  assert.equal(pool.ready(), 2);
  assert.notEqual(pool.pick()?.label, second.label, 'an exit the host refused is not used again yet');
  assert.equal(pool.stats().blocked, 1);

  now += 5_001;
  assert.equal(pool.ready(), 3, 'a cooldown expires by itself');
});

test('an exit the proxy refused is out of the pool; one that answered is at full health', () => {
  const pool = new ProxyPool(builtInProxies().slice(0, 2), { now: () => 0, unusableCooldownMs: 3_600_000 });
  const [first, second] = pool.all();
  assert.ok(first && second);

  pool.report(first, 'unusable', 'the proxy answered HTTP 402');
  assert.equal(pool.ready(), 1);
  assert.equal(pool.pick()?.label, second.label, 'the spent plan is not asked again');

  pool.report(second, 'failed', 'ECONNRESET');
  assert.equal(pool.stats().blocked, 1, 'one dead connection is a pause, not a verdict');
  pool.report(second, 'failed', 'ECONNRESET');
  pool.report(second, 'failed', 'ECONNRESET');
  assert.equal(pool.stats().unusable, 2, 'three in a row and it sits out beside the spent plan');
  assert.equal(pool.ready(), 0);

  pool.report(second, 'ok', 'HTTP 200');
  assert.equal(pool.ready(), 1, 'a good answer clears the history');
  assert.equal(pool.stats().unusable, 1, 'and only for that exit');
});

test('the pool counts what went through the exits, and says once when the plan is spent', () => {
  const logged: string[] = [];
  const pool = new ProxyPool(builtInProxies().slice(0, 1), { budgetBytes: 1_000, log: (message) => logged.push(message) });
  const [only] = pool.all();
  assert.ok(only);

  pool.touch(only);
  pool.count(only, 400);
  pool.touch(only);
  pool.count(only, 700);

  const stats = pool.stats();
  assert.equal(stats.requests, 2);
  assert.equal(stats.bytes, 1_100);
  assert.equal(stats.budgetBytes, 1_000);
  assert.equal(stats.overBudget, true);
  assert.equal(logged.filter((line) => line.includes('SCRAPER_PROXY_BUDGET_MB')).length, 1, 'said once, not per byte');
});

test('a counted response reports the bytes that actually crossed the exit', async () => {
  let bytes = 0;
  const response = countBytes(
    new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } }),
    (size) => (bytes += size),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), 'hello world');
  assert.equal(bytes, 11);

  let none = 0;
  const empty = countBytes(new Response(null, { status: 204 }), (size) => (none += size));
  assert.equal(empty.status, 204);
  assert.equal(none, 0);
});

test('a proxy that refuses the tunnel is read for what it said', () => {
  // The shape undici builds for a `https://` target through a proxy that answers
  // 402 to the CONNECT — captured from the real thing, because nothing else in
  // the chain says *why* the request died.
  const abort = Object.assign(new Error('Proxy response (402) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
  const cancelled = Object.assign(new Error('Request was cancelled.'), { cause: abort });
  const failed = Object.assign(new TypeError('fetch failed'), { cause: cancelled });

  assert.deepEqual(readProxyFailure(failed), { status: 402, message: 'the proxy answered HTTP 402' });
  assert.deepEqual(readProxyFailure(new Error('socket hang up')), { message: 'socket hang up' });
  assert.equal(isProxyRefusal(402), true);
  assert.equal(isProxyRefusal(407), true);
  assert.equal(isProxyRefusal(403), false, 'a 403 is the host talking, not the proxy');
});

test('scrape requests leave through the pool; the download path never touches it', async () => {
  const origin = await startOrigin();
  const proxy = await startFakeProxy({ name: 'exit-a' });
  const pool = new ProxyPool([proxy.endpoint], {});
  configureScraper({ proxies: pool });
  try {
    assert.equal(await fetchText(`${origin.url}/page`, undefined, 5_000), '<html>ok</html>');
    assert.deepEqual(proxy.forwarded, [`${origin.url}/page`], 'the page came through the exit');
    assert.equal(proxy.requests[0]?.authorization, FAKE_PROXY_AUTHORIZATION, 'and with the exit’s own credentials');
    assert.deepEqual(origin.seen, [{ path: '/page', via: 'exit-a' }], 'the host saw the exit, not this machine');

    // The media transport — the same host, the same headers, no proxy: a playlist
    // and every segment behind it are gigabytes, and these exits are metered.
    const playlist = await fetchWithTimeout(`${origin.url}/playlist.m3u8`, {}, 5_000);
    assert.equal(playlist.status, 200);
    assert.equal(proxy.forwarded.length, 1, 'a download must not be billed to the proxy plan');
    assert.deepEqual(
      origin.seen,
      [{ path: '/page', via: 'exit-a' }, { path: '/playlist.m3u8' }],
      'the playlist came straight from this machine',
    );

    assert.equal(pool.stats().bytes > 0, true, 'and the page that did go through was counted');
  } finally {
    releaseScraper();
    await proxy.close();
    await origin.close();
  }
});

test('an exit the host refuses is stepped over before the host is blamed', async () => {
  // The refusing exit identifies itself, so the origin can block exactly one of
  // them — which is what "the block is on the address" looks like from inside.
  const origin = await startOrigin((req, res) => {
    if (req.headers['x-fake-proxy'] === 'exit-a') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('blocked');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>ok</html>');
  });
  const refusing = await startFakeProxy({ name: 'exit-a' });
  const working = await startFakeProxy({ name: 'exit-b' });
  const guard = new HostGuard({ minIntervalMs: 0, baseCooldownMs: 60_000 });
  const pool = new ProxyPool([refusing.endpoint, working.endpoint], {});
  configureScraper({ proxies: pool, guard });
  try {
    assert.equal(await fetchText(`${origin.url}/page`, undefined, 5_000), '<html>ok</html>');
    assert.equal(refusing.requests.length, 1, 'the refused exit was used once');
    assert.equal(working.requests.length, 1, 'and the next exit picked the request up');
    assert.equal(guard.cooling(new URL(origin.url).host), undefined, 'the host itself is not in cooldown');
    assert.equal(pool.stats().blocked, 1, 'the exit that earned the refusal is the one sitting out');
  } finally {
    releaseScraper();
    await refusing.close();
    await working.close();
    await origin.close();
  }
});

test('a pool with nothing usable left falls back to the direct connection', async () => {
  const origin = await startOrigin();
  const spent = await startFakeProxy({ name: 'spent', refuseWith: 402 });
  const pool = new ProxyPool([spent.endpoint], {});
  configureScraper({ proxies: pool });
  try {
    assert.equal(await fetchText(`${origin.url}/page`, undefined, 5_000), '<html>ok</html>');
    assert.equal(spent.requests.length, 1, 'the spent plan was tried');
    assert.equal(pool.ready(), 0, 'and is out of the pool');
    assert.deepEqual(origin.seen, [{ path: '/page' }], 'the request still went out — from this machine');
  } finally {
    releaseScraper();
    await spent.close();
    await origin.close();
  }
});

test('with no pool a refusal is still the host’s, exactly as it was before', async () => {
  const origin = await startOrigin((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('no');
  });
  const guard = new HostGuard({ minIntervalMs: 0, baseCooldownMs: 60_000 });
  configureScraper({ proxies: new ProxyPool([]), guard });
  try {
    assert.equal(await fetchText(`${origin.url}/page`, undefined, 5_000), null, 'a 403 is not a page');
    assert.ok(guard.cooling(new URL(origin.url).host), 'the host is cooled down');
  } finally {
    releaseScraper();
    await origin.close();
  }
});

test('the exit test says which proxies are alive and which are spent', async () => {
  const target = await startOrigin();
  const alive = await startFakeProxy({ name: 'alive' });
  const spent = await startFakeProxy({ name: 'spent', refuseWith: 402 });
  const pool = new ProxyPool([alive.endpoint, spent.endpoint], {});
  try {
    const results = await testExits(pool, { target: `${target.url}/`, concurrency: 2, timeoutMs: 5_000 });
    assert.equal(results.length, 2);

    const ok = results.find((result) => result.label === 'alive');
    const dead = results.find((result) => result.label === 'spent');
    assert.equal(ok?.ok, true);
    assert.equal(ok?.status, 200);
    assert.ok((ok?.bytes ?? 0) > 0, 'the bytes it carried are reported');
    assert.equal(dead?.ok, false);
    assert.match(dead?.error ?? '', /HTTP 402/, 'and the reason names what the proxy said');

    const stats = pool.stats();
    assert.equal(stats.ready, 1);
    assert.equal(stats.unusable, 1);
  } finally {
    await alive.close();
    await spent.close();
    await target.close();
  }
});

test('nothing in the download half of the pipeline can reach the pool', async () => {
  // The exits are metered by the gigabyte, so this is a boundary worth pinning
  // with a test rather than a comment: the media, the upload and the archive must
  // not be one import away from a proxy.
  for (const file of ['hls.ts', 'stream.ts', 'tus.ts', 'r2.ts', 'bunny.ts', 'bunny-core.ts', 'archive.ts']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.equal(
      /from '\.\/proxies'/.test(source),
      false,
      `src/${file} must not import the proxy pool — the download path stays on this machine's connection`,
    );
  }
});

after(async () => {
  await closeDispatchers();
});
