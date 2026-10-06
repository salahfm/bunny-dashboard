import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store, newJob } from '../src/store';
import { testConfig } from './helpers';

test('accounts and settings persist across reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  const store = new Store(config);
  const account = store.addAccount({ name: 'primary', libraryId: '12345', apiKeyEnc: 'enc' });
  assert.equal(store.accounts.length, 1);

  const reloaded = new Store(config);
  assert.equal(reloaded.accounts.length, 1);
  assert.equal(reloaded.account(account.id)?.name, 'primary');

  assert.equal(reloaded.settings.subtitleAutoFill, true, 'filling in a missing language is on by default');

  reloaded.updateSettings({ perAccountConcurrency: 7, subtitleAutoFill: false });
  const again = new Store(config);
  assert.equal(again.settings.perAccountConcurrency, 7);
  assert.equal(again.settings.subtitleAutoFill, false, 'turning the repair off survives a reload');
});

test('the R2 archive switch follows R2_ARCHIVE until the dashboard overrides it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const without = new Store(testConfig(dir));
  assert.equal(without.settings.archiveToR2, false, 'no destination means there is nothing to archive');

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(other, {
    r2: {
      accountId: 'a',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'b',
      prefix: 'archive',
      enabled: true,
      keepBunny: false,
      urlTtl: 300,
      verify: true,
      verifyIntervalMs: 7 * 24 * 60 * 60_000,
    },
  });
  const store = new Store(config);
  assert.equal(store.settings.archiveToR2, true, 'a configured destination turns it on by default');

  store.updateSettings({ archiveToR2: false });
  assert.equal(new Store(config).settings.archiveToR2, false, 'turning it off survives a reload');
  assert.equal(store.settings.archiveToR2, false);
});

test('out-of-range stored settings are clamped on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  const store = new Store(config);
  store.updateSettings({ perAccountConcurrency: 10, maxAccounts: 30 });

  const raw = JSON.parse(fs.readFileSync(config.dbPath, 'utf8')) as { settings: { perAccountConcurrency: number; maxAccounts: number } };
  raw.settings.perAccountConcurrency = 99;
  raw.settings.maxAccounts = 500;
  fs.writeFileSync(config.dbPath, JSON.stringify(raw));

  const reloaded = new Store(config);
  assert.equal(reloaded.settings.perAccountConcurrency, 10);
  assert.equal(reloaded.settings.maxAccounts, 30);
});

/**
 * The dashboard's live queue is built on this: the event stream subscribes once
 * and must hear about every change — including a progress tick, which is the
 * one mutation that deliberately skips the disk write.
 */
test('every job change is announced to listeners, in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  const store = new Store(config);
  const seen: Array<{ kind: string; id: string; status?: string }> = [];
  const stop = store.onJobChange((job, kind) => {
    seen.push({ kind, id: job.id, ...(job.status ? { status: job.status } : {}) });
  });

  const job = store.addJob(newJob({ kind: 'movie', tmdbId: 9, title: 'N' }, { kind: 'file', name: 'n.bin' }));
  store.updateJob(job.id, { progress: 5 });
  store.updateJob(job.id, { status: 'ready' });
  assert.equal(store.removeJob(job.id), true);

  assert.deepEqual(
    seen,
    [
      { kind: 'added', id: job.id, status: 'queued' },
      { kind: 'updated', id: job.id, status: 'queued' },
      { kind: 'updated', id: job.id, status: 'ready' },
      { kind: 'removed', id: job.id, status: 'ready' },
    ],
  );

  stop();
  store.addJob(newJob({ kind: 'movie', tmdbId: 10, title: 'O' }, { kind: 'file', name: 'o.bin' }));
  assert.equal(seen.length, 4, 'a listener that unsubscribed hears nothing more');
});

/** Reporting a change is not allowed to be able to break the queue itself. */
test('a listener that throws cannot break the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  const store = new Store(config);
  store.onJobChange(() => {
    throw new Error('listener exploded');
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    const job = store.addJob(newJob({ kind: 'movie', tmdbId: 11, title: 'P' }, { kind: 'file', name: 'p.bin' }));
    assert.equal(store.updateJob(job.id, { status: 'ready' })?.status, 'ready');
    assert.equal(store.job(job.id)?.status, 'ready');
    assert.equal(store.removeJob(job.id), true);
  } finally {
    console.error = originalError;
  }
});

test('a corrupt database is set aside instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  fs.writeFileSync(config.dbPath, '{not json');
  const store = new Store(config);
  assert.equal(store.accounts.length, 0);
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')));
});

function storedJob(config: { dbPath: string }, id: string): { progress: number; status: string; bytesIn?: number } | undefined {
  const db = JSON.parse(fs.readFileSync(config.dbPath, 'utf8')) as { jobs: Array<{ id: string; progress: number; status: string; bytesIn?: number }> };
  return db.jobs.find((job) => job.id === id);
}

/**
 * A busy queue moves byte counters many times a second. Each of those must not
 * rewrite the whole database, but a status change still has to land at once,
 * and a clean stop must not lose the last progress tick.
 */
test('progress updates coalesce into one write, and flush persists them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-store-'));
  const config = testConfig(dir);
  const store = new Store(config);
  const job = store.addJob(newJob({ kind: 'movie', tmdbId: 1, title: 'X' }, { kind: 'file', name: 'x.bin' }));

  store.updateJob(job.id, { progress: 10 });
  store.updateJob(job.id, { progress: 20, bytesIn: 100, bytesOut: 100 });
  assert.equal(store.hasPendingSave, true, 'byte counters are coalesced, not written per tick');
  assert.equal(storedJob(config, job.id)?.progress, 0, 'nothing volatile is on disk yet');

  store.flush();
  assert.equal(store.hasPendingSave, false);
  assert.equal(storedJob(config, job.id)?.progress, 20, 'flush writes the coalesced progress');

  store.updateJob(job.id, { status: 'failed', error: 'boom' });
  assert.equal(store.hasPendingSave, false, 'a status change is written immediately');
  assert.equal(storedJob(config, job.id)?.status, 'failed');
});
