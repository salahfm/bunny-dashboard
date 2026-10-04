import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decryptSecret, encryptSecret, loadOrCreateSecret, maskSecret } from '../src/crypto';

test('secrets round-trip and are never stored in clear text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-secret-'));
  const secret = loadOrCreateSecret(path.join(dir, '.secret'));
  const payload = encryptSecret(secret, 'sk_live_1234567890');
  assert.ok(!payload.includes('1234567890'));
  assert.equal(decryptSecret(secret, payload), 'sk_live_1234567890');
});

test('a secret reloaded from disk still decrypts previous payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-secret-'));
  const secretPath = path.join(dir, '.secret');
  const first = loadOrCreateSecret(secretPath);
  const payload = encryptSecret(first, 'value');
  const second = loadOrCreateSecret(secretPath);
  assert.equal(decryptSecret(second, payload), 'value');
});

test('maskSecret keeps only the tail', () => {
  assert.equal(maskSecret('abcdef123456'), '••••3456');
  assert.equal(maskSecret('abc'), '••••');
  assert.equal(maskSecret(undefined), null);
});
