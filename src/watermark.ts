/**
 * The watermark every account is given the same way.
 *
 * bunny.net stamps a library's watermark onto everything it encodes, and the
 * settings live on the library: an image, an offset from the top-left corner and
 * a size, all in percentages of the frame. There is no "position: bottom-right"
 * on the wire, so the dashboard keeps a friendlier description and turns it into
 * the four numbers Bunny takes — which is also what makes the mark land in
 * *exactly* the same place on every account instead of wherever each library
 * happened to be configured.
 *
 * There are two ways to describe that position, and they are both just a way of
 * arriving at the same four numbers:
 *
 * - `corner` (the default) pins the mark to one of the four corners and insets
 *   it by a margin — the station-logo arrangement, and the one that keeps every
 *   account identical whatever the frame's shape.
 * - `offset` places it by hand: `left` and `top` are the mark's own edges, in
 *   percent from the top-left of the frame. `0` is flush against the edge, which
 *   is a position no corner-and-margin pair can express as directly (a top-right
 *   mark is `100 - width - margin` from the left, so a left-hand corner is the
 *   only way to reach `0` that way).
 *
 * Both halves are global: one image and one placement, applied to every library
 * this dashboard creates (and to any existing one, on demand). The image is
 * stored next to `db.json` rather than in it, so a megabyte of PNG does not get
 * rewritten every time a job's progress moves.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WatermarkPlacement } from './bunny-core';
import type { AppConfig } from './config';

/** Which corner the mark is pinned to. */
export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const WATERMARK_CORNERS: WatermarkCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * How the position is described: pinned to a corner, or typed in by hand.
 *
 * `corner` is the default because it survives a change of frame: the same
 * corner and the same margin, expressed in percent, land the mark in the same
 * place on a 16:9 film and a 4:3 episode alike. `offset` is for the positions
 * that description cannot reach — most of all "flush against the left edge".
 */
export type WatermarkAnchor = 'corner' | 'offset';

export const WATERMARK_ANCHORS: WatermarkAnchor[] = ['corner', 'offset'];

/**
 * The placement this dashboard uses unless it is told otherwise.
 *
 * Bottom-right, small, and inset a little from the edge — the corner a station
 * logo usually sits in, and far enough from the player's controls to stay
 * legible without covering the picture. `left`/`top` carry what that corner
 * resolves to, so switching to hand placement starts from where the mark already
 * is rather than from a jump to the top-left corner.
 */
export const DEFAULT_WATERMARK_SETTINGS: WatermarkSettings = {
  anchor: 'corner',
  corner: 'bottom-right',
  left: 86,
  top: 90,
  width: 12,
  height: 8,
  margin: 2,
};

/** The largest image Bunny will take for a library watermark. */
export const MAX_WATERMARK_BYTES = 10 * 1024 * 1024;

export interface WatermarkSettings {
  /**
   * How the mark is positioned; treated as `corner` when it is not named.
   *
   * Every field is filled in whichever way the mark is placed, because the
   * dashboard shows the resolved numbers: a corner placement keeps `left`/`top`
   * in step with the corner it derives from, so switching to `offset` is a no-op
   * until one of them is edited.
   */
  anchor?: WatermarkAnchor;
  /** Which corner, and inset by how much — only read when `anchor` is `corner`. */
  corner: WatermarkCorner;
  /** The mark's left edge, in percent from the left — only read when `anchor` is `offset`. */
  left?: number;
  /** The mark's top edge, in percent from the top — only read when `anchor` is `offset`. */
  top?: number;
  /** The mark's width, as a percentage of the video's width. */
  width: number;
  /** The mark's height, as a percentage of the video's height. */
  height: number;
  /** The gap between the mark and the frame's edges, as a percentage. */
  margin: number;
}

/** Where a watermark ended up: the four percentages the core API takes. */
export type WatermarkPlacementRecord = WatermarkPlacement;

export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkError';
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Two decimals is as fine as a percentage of a frame is worth reporting. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Read a number out of an untrusted body, falling back to `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Normalise whatever the dashboard sent into a placement that cannot leave the
 * frame.
 *
 * A mark wider than the picture, or a margin that would push it off the edge,
 * is clamped rather than refused: the point of the setting is "the same mark in
 * the same corner everywhere", and a clamped value still does that consistently.
 */
export function normalizeWatermarkSettings(input: Record<string, unknown>, base: WatermarkSettings = DEFAULT_WATERMARK_SETTINGS): WatermarkSettings {
  const anchor: WatermarkAnchor =
    input.anchor === 'offset' || input.anchor === 'corner' ? input.anchor : base.anchor ?? 'corner';
  const corner = WATERMARK_CORNERS.includes(input.corner as WatermarkCorner) ? (input.corner as WatermarkCorner) : base.corner;
  const width = clamp(numberOr(input.width, base.width), 1, 100);
  const height = clamp(numberOr(input.height, base.height), 1, 100);
  const margin = clamp(numberOr(input.margin, base.margin), 0, 50);
  // Where the corner-and-margin description currently puts the mark. A request
  // that does not name `left`/`top` — every corner-mode save, and any client that
  // predates hand placement — follows the corner, so the stored offsets are
  // always the ones the resolved placement uses. That is what makes changing the
  // corner and then switching to hand placement a smooth move rather than a jump.
  const derived = watermarkPlacement({ corner, width, height, margin });
  const left = clamp(numberOr(input.left, derived.left), 0, 100);
  const top = clamp(numberOr(input.top, derived.top), 0, 100);
  return { anchor, corner, left, top, width, height, margin };
}

/**
 * The four percentages Bunny wants.
 *
 * `left`/`top` are offsets from the *top-left* corner, so the right and bottom
 * corners are the far edge minus the mark's own size and the margin. A
 * hand-placed mark is taken at its word instead — `0` really does mean flush
 * against the edge. Either way everything is clamped again here, because this is
 * the last point before the numbers leave for Bunny.
 */
export function watermarkPlacement(settings: WatermarkSettings): WatermarkPlacementRecord {
  const wide = clamp(settings.width, 1, 100);
  const tall = clamp(settings.height, 1, 100);
  if (settings.anchor === 'offset') {
    // Only the frame itself is enforced: the mark may sit anywhere it fits, and
    // a field that was never set is the top-left corner rather than `NaN`.
    return {
      left: round2(clamp(numberOr(settings.left, 0), 0, 100 - wide)),
      top: round2(clamp(numberOr(settings.top, 0), 0, 100 - tall)),
      width: round2(wide),
      height: round2(tall),
    };
  }
  const right = settings.corner === 'top-right' || settings.corner === 'bottom-right';
  const bottom = settings.corner === 'bottom-left' || settings.corner === 'bottom-right';
  const margin = clamp(settings.margin, 0, 50);
  const left = right ? 100 - wide - margin : margin;
  const top = bottom ? 100 - tall - margin : margin;
  return {
    left: round2(clamp(left, 0, 100 - wide)),
    top: round2(clamp(top, 0, 100 - tall)),
    width: round2(wide),
    height: round2(tall),
  };
}

/** How the watermark is described in the dashboard. */
export interface WatermarkState {
  settings: WatermarkSettings;
  placement: WatermarkPlacementRecord;
  hasImage: boolean;
  contentType: string | null;
  bytes: number | null;
  updatedAt: string | null;
  maxBytes: number;
}

/**
 * The stored watermark: one image and one placement, shared by every account.
 *
 * The JSON half and the image half are separate files, and neither is written
 * unless it changed — an image upload leaves `watermark.json` alone and a
 * placement change leaves the bytes on disk untouched.
 */
export class WatermarkStore {
  private current: WatermarkSettings;
  private meta: { contentType?: string; bytes?: number; updatedAt?: string };

  constructor(private config: AppConfig) {
    const loaded = this.read();
    this.current = loaded.state;
    this.meta = loaded.meta;
  }

  private get settingsPath(): string {
    return path.join(this.config.dataDir, 'watermark.json');
  }

  private get imagePath(): string {
    return path.join(this.config.dataDir, 'watermark-image');
  }

  private read(): { state: WatermarkSettings; meta: { contentType?: string; bytes?: number; updatedAt?: string } } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Record<string, unknown>;
      const meta: { contentType?: string; bytes?: number; updatedAt?: string } = {};
      if (typeof raw.contentType === 'string') meta.contentType = raw.contentType;
      if (Number.isFinite(Number(raw.bytes))) meta.bytes = Number(raw.bytes);
      if (typeof raw.updatedAt === 'string') meta.updatedAt = raw.updatedAt;
      return { state: normalizeWatermarkSettings(raw), meta };
    } catch {
      // Missing, unreadable or corrupt: the defaults are a working watermark as
      // soon as an image is uploaded, so there is nothing to repair.
      return { state: { ...DEFAULT_WATERMARK_SETTINGS }, meta: {} };
    }
  }

  private save(): void {
    const tmp = `${this.settingsPath}.tmp`;
    const payload = { ...this.current, ...this.meta };
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, this.settingsPath);
  }

  get settings(): WatermarkSettings {
    return { ...this.current };
  }

  /** The bytes to hand Bunny, or `undefined` when no image has been uploaded. */
  image(): { bytes: Buffer; contentType: string } | undefined {
    try {
      const bytes = fs.readFileSync(this.imagePath);
      if (!bytes.byteLength) return undefined;
      return { bytes, contentType: this.meta.contentType ?? 'image/png' };
    } catch {
      return undefined;
    }
  }

  state(): WatermarkState {
    const image = this.image();
    return {
      settings: { ...this.current },
      placement: watermarkPlacement(this.current),
      hasImage: Boolean(image),
      contentType: image ? this.meta.contentType ?? 'image/png' : null,
      bytes: image ? image.bytes.byteLength : null,
      updatedAt: this.meta.updatedAt ?? null,
      maxBytes: MAX_WATERMARK_BYTES,
    };
  }

  /** Change the placement (and re-write it for every account, by the caller). */
  updateSettings(input: Record<string, unknown>): WatermarkState {
    this.current = normalizeWatermarkSettings(input, this.current);
    this.save();
    return this.state();
  }

  /**
   * Replace the image.
   *
   * The content type is recorded, not derived from a file name — Bunny is sent
   * whatever the browser said the file was, and the dashboard shows the size so
   * an accidental full-resolution export is visible before it is applied.
   */
  saveImage(bytes: Buffer, contentType: string): WatermarkState {
    if (!bytes.byteLength) throw new WatermarkError('the watermark image is empty');
    if (bytes.byteLength > MAX_WATERMARK_BYTES) {
      throw new WatermarkError(`the watermark image is ${Math.round(bytes.byteLength / 1024)} KB — Bunny takes at most ${MAX_WATERMARK_BYTES / 1024 / 1024} MB`);
    }
    const type = typeof contentType === 'string' && contentType.trim() ? contentType.trim() : 'image/png';
    fs.writeFileSync(this.imagePath, bytes);
    this.meta = { contentType: type, bytes: bytes.byteLength, updatedAt: new Date().toISOString() };
    this.save();
    return this.state();
  }

  clearImage(): WatermarkState {
    try {
      fs.unlinkSync(this.imagePath);
    } catch {
      /* already gone */
    }
    this.meta = {};
    this.save();
    return this.state();
  }
}
