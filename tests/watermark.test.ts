import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WATERMARK_SETTINGS,
  MAX_WATERMARK_BYTES,
  WatermarkError,
  WatermarkStore,
  normalizeWatermarkSettings,
  watermarkPlacement,
} from '../src/watermark';
import { testConfig } from './helpers';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-watermark-'));
}

test('the default placement is a small mark in the bottom-right corner', () => {
  const placement = watermarkPlacement(DEFAULT_WATERMARK_SETTINGS);
  assert.deepEqual(placement, { left: 86, top: 90, width: 12, height: 8 });
});

test('each corner is described as offsets from the top-left', () => {
  const base = { width: 20, height: 10, margin: 5 };
  assert.deepEqual(watermarkPlacement({ ...base, corner: 'top-left' }), { left: 5, top: 5, width: 20, height: 10 });
  assert.deepEqual(watermarkPlacement({ ...base, corner: 'top-right' }), { left: 75, top: 5, width: 20, height: 10 });
  assert.deepEqual(watermarkPlacement({ ...base, corner: 'bottom-left' }), { left: 5, top: 85, width: 20, height: 10 });
  assert.deepEqual(watermarkPlacement({ ...base, corner: 'bottom-right' }), { left: 75, top: 85, width: 20, height: 10 });
});

test('a mark can be placed by hand, including flush against the left edge', () => {
  const corner = { corner: 'top-right' as const, width: 20, height: 15, margin: 0 };
  // The same corner and margin as a corner placement gives: 80% from the left.
  assert.deepEqual(watermarkPlacement(corner), { left: 80, top: 0, width: 20, height: 15 });
  // Placed by hand, 0 is a real offset — the mark sits on the edge.
  assert.deepEqual(watermarkPlacement({ ...corner, anchor: 'offset', left: 0, top: 0 }), {
    left: 0,
    top: 0,
    width: 20,
    height: 15,
  });
  // Also a half-way position no corner can describe.
  assert.deepEqual(watermarkPlacement({ ...corner, anchor: 'offset', left: 30, top: 45 }), {
    left: 30,
    top: 45,
    width: 20,
    height: 15,
  });
});

test('a hand-placed mark that would leave the frame is pulled back inside it', () => {
  const placement = watermarkPlacement({ anchor: 'offset', corner: 'top-left', left: 95, top: 95, width: 20, height: 15, margin: 0 });
  assert.deepEqual(placement, { left: 80, top: 85, width: 20, height: 15 });
  // An offset that was never set is the top-left corner, not NaN.
  assert.deepEqual(watermarkPlacement({ anchor: 'offset', corner: 'top-left', width: 10, height: 10, margin: 0 }), {
    left: 0,
    top: 0,
    width: 10,
    height: 10,
  });
});

test('switching to hand placement starts where the corner put the mark', () => {
  const corner = normalizeWatermarkSettings({ corner: 'bottom-right', width: 20, height: 15, margin: 0 });
  assert.equal(corner.left, 80);
  assert.equal(corner.top, 85);
  const byHand = normalizeWatermarkSettings({ anchor: 'offset' }, corner);
  assert.equal(byHand.anchor, 'offset');
  assert.deepEqual(watermarkPlacement(byHand), watermarkPlacement(corner));
  // An unknown mode is not a mode, and offsets may arrive as strings.
  assert.equal(normalizeWatermarkSettings({ anchor: 'diagonal' }).anchor, 'corner');
  assert.equal(normalizeWatermarkSettings({ anchor: 'offset', left: '0' }).left, 0);
  assert.equal(normalizeWatermarkSettings({ anchor: 'offset', left: 'nowhere' }, corner).left, 80);
});

test('a placement that would leave the frame is pulled back inside it', () => {
  // A mark that fills the frame plus a margin cannot hang off the edge.
  const placement = watermarkPlacement({ corner: 'bottom-right', width: 100, height: 100, margin: 20 });
  assert.deepEqual(placement, { left: 0, top: 0, width: 100, height: 100 });
  // The same for a mark wider than the margin allows.
  const wide = watermarkPlacement({ corner: 'bottom-right', width: 99, height: 99, margin: 10 });
  assert.equal(wide.left, 0);
  assert.equal(wide.top, 0);
});

test('normalizeWatermarkSettings clamps and keeps what it understands', () => {
  assert.deepEqual(normalizeWatermarkSettings({}), DEFAULT_WATERMARK_SETTINGS);
  // An unknown corner is not a corner: the current one stands.
  assert.equal(normalizeWatermarkSettings({ corner: 'middle-somewhere' }, DEFAULT_WATERMARK_SETTINGS).corner, 'bottom-right');
  assert.equal(normalizeWatermarkSettings({ corner: 'top-left' }).corner, 'top-left');
  assert.equal(normalizeWatermarkSettings({ width: 500 }).width, 100);
  assert.equal(normalizeWatermarkSettings({ width: 0 }).width, 1);
  assert.equal(normalizeWatermarkSettings({ margin: -4 }).margin, 0);
  assert.equal(normalizeWatermarkSettings({ margin: 90 }).margin, 50);
  // A number that is not a number cannot silently become zero.
  assert.equal(normalizeWatermarkSettings({ width: 'wide' }).width, DEFAULT_WATERMARK_SETTINGS.width);
});

test('a fresh store has no image but a usable placement', () => {
  const store = new WatermarkStore(testConfig(tempDir()));
  const state = store.state();
  assert.equal(state.hasImage, false);
  assert.equal(state.bytes, null);
  assert.equal(state.contentType, null);
  assert.deepEqual(state.placement, { left: 86, top: 90, width: 12, height: 8 });
  assert.equal(state.maxBytes, MAX_WATERMARK_BYTES);
  assert.equal(store.image(), undefined);
});

test('an uploaded image and placement survive a restart', () => {
  const dir = tempDir();
  const store = new WatermarkStore(testConfig(dir));
  store.updateSettings({ corner: 'top-left', width: 25, height: 15, margin: 4 });
  store.saveImage(Buffer.from('PNG-BYTES'), 'image/png');

  const reopened = new WatermarkStore(testConfig(dir));
  const state = reopened.state();
  assert.equal(state.hasImage, true);
  assert.equal(state.bytes, 9);
  assert.equal(state.contentType, 'image/png');
  // The offsets are stored alongside the corner, because they are what the mark
  // resolves to — a corner save keeps them in step rather than clearing them.
  assert.deepEqual(state.settings, { anchor: 'corner', corner: 'top-left', left: 4, top: 4, width: 25, height: 15, margin: 4 });
  assert.deepEqual(state.placement, { left: 4, top: 4, width: 25, height: 15 });
  assert.equal(reopened.image()?.bytes.toString(), 'PNG-BYTES');
  assert.equal(reopened.image()?.contentType, 'image/png');
});

test('a hand-placed mark survives a restart as offsets', () => {
  const dir = tempDir();
  const store = new WatermarkStore(testConfig(dir));
  store.updateSettings({ anchor: 'offset', corner: 'top-right', left: 0, top: 0, width: 20, height: 15, margin: 0 });
  assert.deepEqual(store.state().placement, { left: 0, top: 0, width: 20, height: 15 });

  const reopened = new WatermarkStore(testConfig(dir));
  assert.deepEqual(reopened.settings, { anchor: 'offset', corner: 'top-right', left: 0, top: 0, width: 20, height: 15, margin: 0 });
  assert.deepEqual(reopened.state().placement, { left: 0, top: 0, width: 20, height: 15 });
});

test('replacing the image keeps the placement', () => {
  const store = new WatermarkStore(testConfig(tempDir()));
  store.updateSettings({ corner: 'top-right', width: 10, height: 10, margin: 1 });
  store.saveImage(Buffer.from('ONE'), 'image/png');
  store.saveImage(Buffer.from('TWO-LONGER'), 'image/jpeg');
  const state = store.state();
  assert.equal(state.bytes, 10);
  assert.equal(state.contentType, 'image/jpeg');
  assert.equal(state.settings.corner, 'top-right');
});

test('clearing the image leaves the placement alone', () => {
  const store = new WatermarkStore(testConfig(tempDir()));
  store.saveImage(Buffer.from('PNG'), 'image/png');
  store.clearImage();
  const state = store.state();
  assert.equal(state.hasImage, false);
  assert.equal(store.image(), undefined);
  assert.deepEqual(state.settings, DEFAULT_WATERMARK_SETTINGS);
  // Clearing twice is not an error: there is nothing left to remove.
  assert.equal(store.clearImage().hasImage, false);
});

test('an empty or oversized image is refused', () => {
  const store = new WatermarkStore(testConfig(tempDir()));
  assert.throws(() => store.saveImage(Buffer.alloc(0), 'image/png'), WatermarkError);
  assert.throws(() => store.saveImage(Buffer.alloc(MAX_WATERMARK_BYTES + 1), 'image/png'), (error: unknown) => {
    assert.ok(error instanceof WatermarkError);
    assert.match(error.message, /at most 10 MB/);
    return true;
  });
  // Neither attempt left anything behind.
  assert.equal(store.state().hasImage, false);
});

test('a corrupt settings file falls back to the defaults instead of failing', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'watermark.json'), '{ this is not json');
  const store = new WatermarkStore(testConfig(dir));
  assert.deepEqual(store.settings, DEFAULT_WATERMARK_SETTINGS);
  assert.equal(store.state().hasImage, false);
});
