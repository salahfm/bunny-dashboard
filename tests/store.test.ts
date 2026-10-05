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

  reloaded.updateSettings({ perAccountConcurrency: 7 });
  const again = new Store(config);
  assert.equal(again.settings.perAccountConcurrency, 7);
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
