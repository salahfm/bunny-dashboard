import assert from 'node:assert/strict';
import test from 'node:test';
import { HostGuard, hostOf, looksLikeChallenge, retryAfterMs } from '../src/hostguard';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('a refusal puts a host in cooldown, and it recovers on its own', () => {
  let now = 1_000;
  const guard = new HostGuard({ baseCooldownMs: 5_000, now: () => now });

  const blocked = guard.observe('blocked.test', 429, new Headers());
  assert.ok(blocked, 'a 429 must cool the host down');
  assert.equal(blocked.host, 'blocked.test');
  assert.equal(blocked.reason, 'HTTP 429');
  assert.equal(blocked.until, now + 5_000);
  const cooling = guard.cooling('blocked.test');
  assert.ok(cooling);
  assert.equal(cooling.until, now + 5_000);

  // A success elsewhere is not a cooldown, and a 200 clears the failure history.
  assert.equal(guard.observe('fine.test', 200), undefined);
  assert.equal(guard.cooling('fine.test'), undefined);

  now += 5_001;
  assert.equal(guard.cooling('blocked.test'), undefined, 'the cooldown expires by itself');
});

test('a Retry-After header is honoured over the default cooldown', () => {
  const guard = new HostGuard({ baseCooldownMs: 1_000, now: () => 0 });
  guard.observe('throttled.test', 503, new Headers({ 'retry-after': '120' }));
  assert.equal(guard.cooling('throttled.test')?.until, 120_000);

  guard.observe('when.test', 429, new Headers({ 'retry-after': new Date(45_000).toUTCString() }));
  assert.equal(guard.cooling('when.test')?.until, 45_000);
});

test('a host that keeps refusing waits longer each time', () => {
  const guard = new HostGuard({ baseCooldownMs: 1_000, maxCooldownMs: 10_000, now: () => 0 });
  assert.equal(guard.penalize('repeat.test', 'HTTP 403').until, 1_000);
  assert.equal(guard.penalize('repeat.test', 'HTTP 403').until, 2_000);
  assert.equal(guard.penalize('repeat.test', 'HTTP 403').until, 4_000);
  assert.equal(guard.penalize('repeat.test', 'HTTP 403').until, 8_000);
  assert.equal(guard.penalize('repeat.test', 'HTTP 403').until, 10_000, 'the ceiling holds');
});

test('requests to one host are paced and never overlap', async () => {
  let now = 1_000;
  const guard = new HostGuard({ minIntervalMs: 50, now: () => now, sleep: async (ms) => void (now += ms) });
  const starts: number[] = [];
  await guard.run('paced.test', async () => void starts.push(now));
  now += 10;
  await guard.run('paced.test', async () => void starts.push(now));
  assert.equal(starts.length, 2);
  assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 50, 'the second request waits out the interval');

  const order: string[] = [];
  const serial = new HostGuard({ minIntervalMs: 0 });
  await Promise.all([
    serial.run('one.test', async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
    }),
    serial.run('one.test', async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
    }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], 'two requests to one host must not overlap');
});

test('the guard reports what is cooling down', () => {
  const guard = new HostGuard({ baseCooldownMs: 1_000, now: () => 0 });
  guard.penalize('b.test', 'a bot challenge');
  guard.penalize('a.test', 'HTTP 429');
  assert.deepEqual(
    guard.snapshot().map((entry) => entry.host),
    ['a.test', 'b.test'],
    'soonest to recover first',
  );
  guard.clear();
  assert.equal(guard.snapshot().length, 0);
});

test('a bot wall is recognised as a refusal, not a page', () => {
  assert.equal(looksLikeChallenge('<!doctype html><title>Just a moment...</title>'), true);
  assert.equal(looksLikeChallenge('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>'), true);
  assert.equal(looksLikeChallenge('DDoS-Guard protection'), true);
  assert.equal(looksLikeChallenge('<html><body id="player"></body></html>'), false);

  assert.equal(hostOf('https://VidFast.VC/movie/1'), 'vidfast.vc');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '30' }), 0), 30_000);
  assert.equal(retryAfterMs(new Headers(), 0), undefined);
});
