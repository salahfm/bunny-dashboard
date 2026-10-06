import assert from 'node:assert/strict';
import test from 'node:test';
import { HARD_MAX_SUBTITLE_TARGETS, clampConcurrency, clampMaxAccounts, parseR2, parseSubtitleTargets, parseUploadMode } from '../src/config';
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

test('SUBTITLE_TARGET_LANG accepts one language or a list, and defaults to Arabic', () => {
  assert.deepEqual(parseSubtitleTargets(undefined), ['ar']);
  assert.deepEqual(parseSubtitleTargets(''), ['ar']);
  assert.deepEqual(parseSubtitleTargets('ar'), ['ar']);
  // Commas and plain whitespace both separate, because this is typed by hand.
  assert.deepEqual(parseSubtitleTargets('ar,fr,es'), ['ar', 'fr', 'es']);
  assert.deepEqual(parseSubtitleTargets('ar fr es'), ['ar', 'fr', 'es']);
  // Names are read too, and region codes collapse to their language.
  assert.deepEqual(parseSubtitleTargets('Arabic, French, Spanish'), ['ar', 'fr', 'es']);
  assert.deepEqual(parseSubtitleTargets('en-US, pt-BR'), ['en', 'pt']);
  // Order is kept (it is the order captions are produced in), duplicates collapse.
  assert.deepEqual(parseSubtitleTargets('fr, ar, fr'), ['fr', 'ar']);
  // A typo is dropped rather than guessed at; nothing recognisable means Arabic.
  assert.deepEqual(parseSubtitleTargets('ar, klingon, es'), ['ar', 'es']);
  assert.deepEqual(parseSubtitleTargets('klingon'), ['ar']);
});

test('the target list is capped so one typo cannot turn a publish into twenty translations', () => {
  const many = ['ar', 'fr', 'es', 'de', 'pt', 'it', 'ru', 'tr', 'hi', 'ur', 'fa', 'he', 'zh', 'ja', 'ko'];
  const parsed = parseSubtitleTargets(many.join(','));
  assert.equal(parsed.length, HARD_MAX_SUBTITLE_TARGETS);
  assert.deepEqual(parsed.slice(0, 3), ['ar', 'fr', 'es'], 'the first languages named are the ones kept');
});

test('the R2 archive needs all of its keys, or none of them', () => {
  // Nothing set means no archive at all, which is not an error.
  assert.deepEqual(parseR2({}), {});

  // Half a block is a typo, and archiving nothing is not what the typo meant.
  const partial = parseR2({ R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'archive' });
  assert.equal(partial.config, undefined);
  assert.match(partial.notice ?? '', /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);

  const full = parseR2({
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'archive',
    // A pasted path and trailing slashes are normalised away.
    R2_PREFIX: '/videos/',
    R2_PUBLIC_BASE: 'https://pub-abc.r2.dev/',
  });
  assert.deepEqual(full.config, {
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'archive',
    publicBase: 'https://pub-abc.r2.dev',
    prefix: 'videos',
    enabled: true,
    keepBunny: false,
    urlTtl: 300,
    verify: true,
    verifyIntervalMs: 7 * 24 * 60 * 60_000,
  });
});

test('the archive switches read like every other flag, and the prefix has a default', () => {
  const base = { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' };
  // On by default once a destination exists: configuring R2 is the opt-in.
  assert.equal(parseR2(base).config?.enabled, true);
  assert.equal(parseR2({ ...base, R2_ARCHIVE: 'off' }).config?.enabled, false);
  // Keeping the Bunny copy is the opposite switch, and off by default.
  assert.equal(parseR2({ ...base, R2_KEEP_BUNNY: '1' }).config?.keepBunny, true);
  assert.equal(parseR2({ ...base, R2_PREFIX: '   ' }).config?.prefix, 'archive');
  // The signed playback URL's life: five minutes by default, clamped to S3's range.
  assert.equal(parseR2(base).config?.urlTtl, 300);
  assert.equal(parseR2({ ...base, R2_URL_TTL: '900' }).config?.urlTtl, 900);
  assert.equal(parseR2({ ...base, R2_URL_TTL: '0' }).config?.urlTtl, 1);
  assert.equal(parseR2({ ...base, R2_URL_TTL: '99999999' }).config?.urlTtl, 604_800);
  assert.equal(parseR2({ ...base, R2_URL_TTL: 'soon' }).config?.urlTtl, 300);
  // The scheduled re-check: weekly and on by default, clamped to 1 h – 30 days.
  assert.equal(parseR2(base).config?.verify, true);
  assert.equal(parseR2({ ...base, R2_VERIFY: 'off' }).config?.verify, false);
  assert.equal(parseR2(base).config?.verifyIntervalMs, 7 * 24 * 60 * 60_000);
  assert.equal(parseR2({ ...base, R2_VERIFY_INTERVAL_MS: '86400000' }).config?.verifyIntervalMs, 86_400_000);
  assert.equal(parseR2({ ...base, R2_VERIFY_INTERVAL_MS: '1' }).config?.verifyIntervalMs, 60 * 60_000);
  assert.equal(parseR2({ ...base, R2_VERIFY_INTERVAL_MS: '99999999999' }).config?.verifyIntervalMs, 30 * 24 * 60 * 60_000);
  assert.equal(parseR2({ ...base, R2_VERIFY_INTERVAL_MS: 'soon' }).config?.verifyIntervalMs, 7 * 24 * 60 * 60_000);
});

test('the TUS chunk size is clamped to sane bounds', () => {
  assert.equal(clampChunkBytes(undefined), DEFAULT_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes(4 * 1024 * 1024), 4 * 1024 * 1024);
  assert.equal(clampChunkBytes(1), MIN_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes(Number.MAX_SAFE_INTEGER), MAX_TUS_CHUNK_BYTES);
  assert.equal(clampChunkBytes('nonsense'), DEFAULT_TUS_CHUNK_BYTES);
});
