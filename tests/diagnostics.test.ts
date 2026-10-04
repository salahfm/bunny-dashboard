/**
 * The network check's report.
 *
 * The prober is injected, so the shape and the verdict are tested without
 * touching a real host: what matters is that a reachable Bunny API is reported
 * as the one required check, that an unreachable one is *the* verdict (rather
 * than one red row among many), and that mock mode probes nothing at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDiagnostics } from '../src/diagnostics';
import { Store } from '../src/store';
import { testConfig } from './helpers';

function setup(mock = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-diag-'));
  const config = testConfig(dir, { mock, networkTimeoutMs: 5_000 });
  const store = new Store(config);
  store.addAccount({ name: 'lib', libraryId: '1', apiKeyEnc: 'x', pullZoneHost: 'vz-demo.b-cdn.net' });
  return { config, store, dir };
}

test('mock mode probes nothing and says so', async () => {
  const { config, store, dir } = setup(true);
  try {
    const report = await runDiagnostics({ config, store });
    assert.equal(report.skipped, true);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks, []);
    assert.match(report.summary, /mock mode/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every host answering reads as one line', async () => {
  const { config, store, dir } = setup();
  try {
    const report = await runDiagnostics({
      config,
      store,
      probe: async (label) => ({ label, host: label, ok: true, status: 200, ms: 12 }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.summary, 'every host answered');
    assert.ok(report.checks.some((check) => check.role === 'required' && check.label === 'Bunny API'));
    assert.ok(
      report.checks.some((check) => check.role === 'playback' && check.label.includes('lib')),
      'the pull zone of every enabled account is checked',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable Bunny API is the verdict, and a dead scraping host is not', async () => {
  const { config, store, dir } = setup();
  try {
    const report = await runDiagnostics({
      config,
      store,
      probe: async (label) => ({
        label,
        host: label,
        ok: label !== 'Bunny API' && label !== 'Movy',
        ms: 5_000,
        ...(label === 'Bunny API'
          ? { error: 'no answer within 5s' }
          : label === 'Movy'
            ? { error: 'HTTP 503' }
            : { status: 200 }),
      }),
    });
    assert.equal(report.ok, false);
    assert.match(report.summary, /Bunny API is NOT reachable/);
    assert.match(report.summary, /video\.bunnycdn\.com/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with Bunny reachable, a scraping host being down is reported without failing the check', async () => {
  const { config, store, dir } = setup();
  try {
    const report = await runDiagnostics({
      config,
      store,
      probe: async (label) => ({ label, host: label, ok: label !== 'Rigel', status: 200, ms: 30, ...(label === 'Rigel' ? { error: 'ECONNREFUSED' } : {}) }),
    });
    assert.equal(report.ok, true);
    assert.match(report.summary, /Bunny is reachable/);
    assert.match(report.summary, /Rigel/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
