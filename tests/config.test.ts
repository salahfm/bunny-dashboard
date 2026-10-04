import assert from 'node:assert/strict';
import test from 'node:test';
import { clampConcurrency, clampMaxAccounts, parseUploadMode } from '../src/config';
import { DEFAULT_TUS_CHUNK_BYTES, MAX_TUS_CHUNK_BYTES, MIN_TUS_CHUNK_BYTES, clampChunkBytes } from '../src/tus';

test('per-account concurrency is clamped to the hard cap of 10', () => {
  assert.equal(clampConcurrency(50), 10);
  assert.equal(clampConcurrency(10), 10);
  assert.equal(clampConcurrency(4), 4);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency('nonsense'), 10);
});

test('the account limit is clamped to the hard cap of 30', () => {
  assert.equal(clampMaxAccounts(500), 30);
  assert.equal(clampMaxAccounts(30), 30);
  assert.equal(clampMaxAccounts(12), 12);
  assert.equal(clampMaxAccounts(0), 1);
});

test('resumable uploads are the default, with put as an escape hatch', () => {
  assert.equal(parseUploadMode(undefined), 'tus');
  assert.equal(parseUploadMode('TUS'), 'tus');
  assert.equal(parseUploadMode('put'), 'put');
  assert.equal(parseUploadMode('nonsense'), 'tus');
});

test('the TUS chunk size is clamped to sane bounds', () => {
  assert.equal(clampChunkBytes(undefined), DEFAULT_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes(4 * 1024 * 1024), 4 * 1024 * 1024);
  assert.equal(clampChunkBytes(1), MIN_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes(Number.MAX_SAFE_INTEGER), MAX_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes('nonsense'), DEFAULT_TUS_CHUNK_BYTES);
});
