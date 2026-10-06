/**
 * The *account* half of bunny.net: video libraries themselves.
 *
 * `src/bunny.ts` speaks to one Stream library (`video.bunnycdn.com`, keyed by
 * that library's own Stream API key). Everything about the library — its
 * enabled resolutions, its pull zone, and the watermark that is stamped onto
 * every video it encodes — lives on the account-level API instead
 * (`api.bunny.net`, keyed by the *account* API key from
 * Dashboard → profile → Edit account details → API Key).
 *
 * The two keys are not interchangeable: Bunny rejects a Stream library key on
 * the core API and an account key on the Stream API, with a 401 that says
 * nothing about which of the two you got wrong. Keeping the pair in separate
 * clients is what makes that distinction obvious in the code as well as in the
 * dashboard.
 *
 * The one thing that ties the halves together is [BunnyCoreClient.provisionLibrary]:
 * create the library, read back the Stream API key Bunny generated for it,
 * enable every resolution, turn on scaling by both dimensions, upload the shared
 * watermark and pin its position and size. That is the whole of "add an
 * account": one account API key in, a ready-to-publish Stream library out.
 */
import { BunnyError } from './bunny';
import { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS, NetworkError, fetchWithPolicy } from './net';

/** Where the core API lives. */
export const BUNNY_CORE_BASE = 'https://api.bunny.net';

/**
 * Every resolution a Stream library can be asked to encode.
 *
 * This is the list Bunny's own dashboard offers for a video library, and the
 * order is the one the dashboard writes: ascending. A library that has all of
 * them enabled re-encodes an upload into whichever rungs its source can supply.
 */
export const ALL_RESOLUTIONS = ['240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

/** `EnabledResolutions` is a comma-separated string on the wire, not an array. */
export function resolutionsValue(heights: readonly string[] = ALL_RESOLUTIONS): string {
  return heights.join(',');
}

/**
 * The encoding flags every library this dashboard makes or fixes carries.
 *
 * `ScaleVideoUsingBothDimensions` is the API behind Bunny's "scale video by
 * height and width" switch, which is off on a library Bunny's own panel created.
 * It is documented on the *update* call only, so it travels with the resolution
 * ladder rather than with the create call — the same request that sets the ladder
 * sets this, and a library that never took it shows up in the read-back check.
 *
 * (An earlier version of this file sent it on create as well; Bunny ignores
 * fields it does not know, so it made no difference — one documented call is
 * easier to reason about than two speculative ones.)
 */
export const LIBRARY_ENCODING_SETTINGS: Record<string, unknown> = { ScaleVideoUsingBothDimensions: true };

export const SCALE_BY_BOTH_DIMENSIONS = 'ScaleVideoUsingBothDimensions';

/**
 * A video library as the core API describes it.
 *
 * Only the fields this dashboard acts on are named; the response carries a
 * couple of hundred more and they are left as they came. `ApiKey` is the
 * *Stream* key the library was born with — the same value the dashboard shows
 * under Stream → your library → API, and the credential `BunnyClient` needs.
 */
export interface BunnyLibrary {
  Id: number;
  Name?: string;
  /** The library's Stream API key: what video.bunnycdn.com authenticates with. */
  ApiKey?: string;
  ReadOnlyApiKey?: string;
  PullZoneId?: number;
  StorageZoneId?: number;
  HasWatermark?: boolean;
  /** Percentages, as bunny.net describes them. */
  WatermarkPositionLeft?: number;
  WatermarkPositionTop?: number;
  WatermarkWidth?: number;
  WatermarkHeight?: number;
  EnabledResolutions?: string;
  /**
   * Bunny's "scale video by height and width": whether an upload is scaled using
   * both dimensions rather than one. Off by default on a library Bunny's own
   * panel created, which is why every library this dashboard configures turns it
   * on and the read-back check looks for it.
   */
  ScaleVideoUsingBothDimensions?: boolean;
  [key: string]: unknown;
}

/** The pull zone a library serves from, and the hostnames pointed at it. */
export interface BunnyPullZone {
  Id: number;
  Name?: string;
  Hostnames?: Array<{ Value?: string; IsSystemHostname?: boolean }>;
  VideoLibraryId?: number;
  [key: string]: unknown;
}

/**
 * The watermark placement, in the percentages the core API takes.
 *
 * `left`/`top` are offsets from the top-left corner and `width`/`height` are the
 * watermark's size relative to the frame — which is what makes a placement
 * reproducible across libraries of different sizes.
 */
export interface WatermarkPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How far a placement may sit from the setting before it counts as drift.
 *
 * One percentage point: Bunny may round what it stores, and a mark a single
 * percent off its corner is not something anyone will ever see. A placement
 * that has genuinely moved — the wrong corner, a stale value from a library
 * configured by hand — is always further out than this.
 */
export const PLACEMENT_TOLERANCE = 1;

/** What a library is supposed to look like, for the read-back check. */
export interface LibraryExpectation {
  /** The rungs it should have enabled (default: every resolution). */
  resolutions?: readonly string[];
  /** The placement this dashboard pushes. */
  watermark?: WatermarkPlacement;
  /** Whether an image should be on the library at all. */
  expectImage?: boolean;
  /**
   * Whether "scale video by height and width" should be on.
   *
   * Defaults to true, like the resolution ladder: a check run without saying so
   * is still asking whether the library holds what this dashboard configures.
   */
  scaleByBothDimensions?: boolean;
}

/** One way a library differs from what the dashboard asked for. */
export interface LibraryFinding {
  /** Which part of the library drifted. */
  field: 'resolutions' | 'encoding' | 'watermark-placement' | 'watermark-image';
  /** What the dashboard asked for, in prose. */
  expected: string;
  /** What bunny.net reports, in prose. */
  actual: string;
  /** One line the dashboard can render as-is. */
  message: string;
}

/** The enabled rungs a library reports, normalised to a set. */
export function enabledResolutionSet(availableResolutions: string | undefined): Set<string> {
  const rungs = new Set<string>();
  if (!availableResolutions) return rungs;
  for (const part of String(availableResolutions).split(',')) {
    const rung = part.trim().toLowerCase();
    if (rung) rungs.add(rung);
  }
  return rungs;
}

/** What Bunny stored for a placement, with `undefined` where it said nothing. */
function storedPlacement(library: BunnyLibrary): Partial<WatermarkPlacement> {
  const stored: Partial<WatermarkPlacement> = {};
  if (Number.isFinite(library.WatermarkPositionLeft)) stored.left = Number(library.WatermarkPositionLeft);
  if (Number.isFinite(library.WatermarkPositionTop)) stored.top = Number(library.WatermarkPositionTop);
  if (Number.isFinite(library.WatermarkWidth)) stored.width = Number(library.WatermarkWidth);
  if (Number.isFinite(library.WatermarkHeight)) stored.height = Number(library.WatermarkHeight);
  return stored;
}

/**
 * Compare what bunny.net holds with what this dashboard asked for.
 *
 * The point of reading a library back is that nothing else would notice it had
 * drifted: the dashboard's own settings stay correct while the library quietly
 * keeps a watermark in some other corner, a narrower ladder of resolutions, or
 * an image that was never replaced. Nothing here writes anything — it is the
 * list of differences, and an empty list means the two agree.
 *
 * Two things are deliberately *not* checked, because Bunny does not report
 * them: whether the stored image is the *same* PNG this dashboard holds (only
 * that one exists), and anything about the library's pull zone.
 */
export function libraryDrift(library: BunnyLibrary, expected: LibraryExpectation = {}): LibraryFinding[] {
  const findings: LibraryFinding[] = [];

  const wanted = expected.resolutions ?? ALL_RESOLUTIONS;
  const have = enabledResolutionSet(library.EnabledResolutions);
  if (have.size === 0) {
    // An empty field means Bunny is not saying, not that nothing is enabled —
    // either way the ladder cannot be confirmed from here, which is worth
    // saying rather than reporting as agreement.
    findings.push({
      field: 'resolutions',
      expected: `every resolution enabled (${wanted.join(', ')})`,
      actual: 'Bunny reported no enabled resolutions',
      message: `Bunny did not report an enabled-resolution ladder, so ${wanted.length} resolution(s) could not be confirmed`,
    });
  } else {
    const missing = wanted.filter((rung) => !have.has(rung.toLowerCase()));
    if (missing.length) {
      findings.push({
        field: 'resolutions',
        expected: wanted.join(', '),
        // Bunny's own string, not the normalised set: "what it holds" should be
        // readable back to the API as it was written.
        actual: String(library.EnabledResolutions).trim(),
        message: `missing ${missing.join(', ')}`,
      });
    }
  }

  if ((expected.scaleByBothDimensions ?? true) && library.ScaleVideoUsingBothDimensions !== true) {
    // The field is either off or absent, and both are worth saying out loud: a
    // library that never took the setting is the shape a Bunny-made one has.
    findings.push({
      field: 'encoding',
      expected: 'videos scaled by height and width (ScaleVideoUsingBothDimensions)',
      actual:
        library.ScaleVideoUsingBothDimensions === undefined
          ? 'Bunny did not report it'
          : `Bunny holds ${String(library.ScaleVideoUsingBothDimensions)}`,
      message: '"scale video by height and width" is off, so uploads are not scaled using both dimensions',
    });
  }

  if (expected.watermark) {
    const stored = storedPlacement(library);
    const off = (['left', 'top', 'width', 'height'] as const).filter((key) => {
      const value = stored[key];
      // A field Bunny did not report at all is drift, not a match: `NaN > 1` is
      // false, so this has to be an explicit "is it a number" test first.
      if (value === undefined) return true;
      return Math.abs(value - expected.watermark![key]) > PLACEMENT_TOLERANCE;
    });
    if (off.length) {
      const describe = (placement: Partial<WatermarkPlacement>): string =>
        (['left', 'top', 'width', 'height'] as const)
          .map((key) => {
            const value = placement[key];
            // A field Bunny never reported is shown as a dash rather than as
            // "0%", which would look like a placement in the top-left corner.
            return value === undefined ? `${key} —` : `${key} ${Math.round(value * 100) / 100}%`;
          })
          .join(', ');
      findings.push({
        field: 'watermark-placement',
        expected: describe(expected.watermark),
        actual: describe(stored),
        message: `the watermark sits somewhere else (expected ${describe(expected.watermark)}, Bunny holds ${describe(stored)})`,
      });
    }
  }

  // `HasWatermark` is the only thing Bunny reports about the image itself: the
  // bytes are never handed back, so presence is as far as this can go.
  if (expected.expectImage === true && library.HasWatermark !== true) {
    findings.push({
      field: 'watermark-image',
      expected: 'a watermark image',
      actual: 'no watermark image',
      message: 'Bunny holds no watermark image on this library',
    });
  }
  if (expected.expectImage === false && library.HasWatermark === true) {
    findings.push({
      field: 'watermark-image',
      expected: 'no watermark image',
      actual: 'a watermark image',
      message: 'Bunny holds a watermark image this dashboard did not upload',
    });
  }

  return findings;
}

/** What a provisioned library turned out to be. */
export interface ProvisionedLibrary {
  library: BunnyLibrary;
  libraryId: string;
  /** The Stream key Bunny generated for the new library. */
  streamApiKey: string;
  /** The library's own CDN hostname, when the pull zone could be read back. */
  pullZoneHost?: string;
  /** True once the watermark image was accepted by Bunny. */
  watermarkApplied: boolean;
}

export interface BunnyCoreOptions {
  /** The *account* API key. A Stream library key will be refused with a 401. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  mock?: boolean;
  /** Per-attempt ceiling for the control plane (default [DEFAULT_FETCH_TIMEOUT_MS]). */
  timeoutMs?: number;
  /** Extra attempts after the first, for a flaky network (default 3). */
  retries?: number;
}

/**
 * The account-level client.
 *
 * Everything it throws is a [BunnyError] carrying the HTTP status, so the
 * dashboard's shared error handler reports a refused key (401) differently from
 * a library that does not exist (404) without every route re-checking.
 */
export class BunnyCoreClient {
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private mock: boolean;
  private timeoutMs?: number;
  private retries?: number;

  constructor(options: BunnyCoreOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mock = options.mock ?? false;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
    if (options.retries !== undefined) this.retries = options.retries;
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchWithPolicy(url, init, {
        what: 'the Bunny API',
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        retries: this.retries ?? DEFAULT_FETCH_RETRIES,
      });
    } catch (error) {
      if (error instanceof NetworkError) throw new BunnyError(error.message, error.status);
      throw error;
    }
  }

  private async ensureOk(response: Response): Promise<void> {
    if (response.ok) return;
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string; Message?: string };
      detail = body.message ?? body.Message ?? '';
    } catch {
      /* not every error is JSON */
    }
    const hint = response.status === 401 ? ' — this call needs the account API key (Dashboard → profile → API Key), not a library Stream key' : '';
    throw new BunnyError(`Bunny request failed (${response.status})${detail ? `: ${detail}` : hint}`, response.status);
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(`${BUNNY_CORE_BASE}${pathname}`, {
      ...init,
      headers: {
        AccessKey: this.apiKey,
        accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    await this.ensureOk(response);
    // A 204 (deleting a watermark) and a couple of the mutating calls answer
    // with no body at all; an empty object is the honest reading of that.
    return (await response.json().catch(() => ({}))) as T;
  }

  /** Create a video library under the account. */
  async createVideoLibrary(name: string, extra: Record<string, unknown> = {}): Promise<BunnyLibrary> {
    const body = { Name: name, EnabledResolutions: resolutionsValue(), ...extra };
    if (this.mock) return mockCreateLibrary(name, body);
    return this.request<BunnyLibrary>('/videolibrary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** One library, by the id its URL carries. */
  async getVideoLibrary(id: number | string): Promise<BunnyLibrary> {
    if (this.mock) return mockGetLibrary(Number(id));
    return this.request<BunnyLibrary>(`/videolibrary/${encodeURIComponent(String(id))}`);
  }

  /**
   * Change a library's settings.
   *
   * The core API patches by replacement: a field left out keeps its current
   * value, which is why every caller here sends only what it means to change.
   */
  async updateVideoLibrary(id: number | string, patch: Record<string, unknown>): Promise<BunnyLibrary> {
    // The mock records the patch, so a library that has been configured reads
    // back configured — which is what makes the read-back check meaningful
    // without credentials.
    if (this.mock) return mockUpdateLibrary(Number(id), patch);
    return this.request<BunnyLibrary>(`/videolibrary/${encodeURIComponent(String(id))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  /**
   * The whole encoding half of a library's settings, in one call.
   *
   * The ladder of rungs plus the flags that are shared by every library, which
   * is why this is no longer just "enable every resolution": Bunny keeps both on
   * the same object, and one request leaves the library configured rather than
   * two that could half-succeed.
   */
  async configureEncoding(id: number | string, resolutions: readonly string[] = ALL_RESOLUTIONS): Promise<BunnyLibrary> {
    return this.updateVideoLibrary(id, {
      EnabledResolutions: resolutionsValue(resolutions),
      ...LIBRARY_ENCODING_SETTINGS,
    });
  }

  /**
   * Set where the watermark sits and how large it is, in percentages.
   *
   * `extra` lets a caller fold another setting into the same request — which
   * provisioning does with the resolution ladder, so a new library is left whole
   * by one call rather than two.
   */
  async setWatermarkPlacement(
    id: number | string,
    placement: WatermarkPlacement,
    extra: Record<string, unknown> = {},
  ): Promise<BunnyLibrary> {
    return this.updateVideoLibrary(id, {
      WatermarkPositionLeft: placement.left,
      WatermarkPositionTop: placement.top,
      WatermarkWidth: placement.width,
      WatermarkHeight: placement.height,
      ...extra,
    });
  }

  /**
   * Upload the watermark image itself.
   *
   * Bunny takes the file as the raw request body — its API reference documents
   * no JSON schema for this call, and the only hints are the "uploaded file"
   * size errors — so the bytes go on the wire untouched, with the image's own
   * content type. The library's placement is a separate call; this one is what
   * makes `HasWatermark` true.
   *
   * Because the framing is undocumented, a `400`/`415` is retried once as a
   * bare `application/octet-stream`. That is the other framing Bunny could
   * want, and unlike a wrong key (`401`) or an oversized file (`413`) it says
   * nothing about the request being *wrong* — only about how it was labelled.
   */
  async uploadWatermark(id: number | string, image: Buffer | Uint8Array, contentType = 'image/png'): Promise<void> {
    if (this.mock) {
      mockUpdateLibrary(Number(id), { HasWatermark: true });
      return;
    }
    const body = Buffer.isBuffer(image) ? image : Buffer.from(image);
    const put = (type: string): Promise<Response> =>
      this.send(`${BUNNY_CORE_BASE}/videolibrary/${encodeURIComponent(String(id))}/watermark`, {
        method: 'PUT',
        headers: {
          AccessKey: this.apiKey,
          accept: 'application/json',
          'content-type': type,
          'content-length': String(body.byteLength),
        },
        body: body as unknown as NonNullable<RequestInit['body']>,
      });
    const response = await put(contentType);
    if (response.ok) return;
    if (response.status === 400 || response.status === 415) {
      await this.ensureOk(await put('application/octet-stream'));
      return;
    }
    await this.ensureOk(response);
  }

  /** Remove a library's watermark image. */
  async deleteWatermark(id: number | string): Promise<void> {
    if (this.mock) {
      mockUpdateLibrary(Number(id), { HasWatermark: false });
      return;
    }
    const response = await this.send(`${BUNNY_CORE_BASE}/videolibrary/${encodeURIComponent(String(id))}/watermark`, {
      method: 'DELETE',
      headers: { AccessKey: this.apiKey, accept: 'application/json' },
    });
    await this.ensureOk(response);
  }

  /** The pull zone behind a library, which is where its CDN hostname lives. */
  async getPullZone(id: number | string): Promise<BunnyPullZone> {
    if (this.mock) return mockPullZone(Number(id));
    return this.request<BunnyPullZone>(`/pullzone/${encodeURIComponent(String(id))}`);
  }

  /** Every library the account owns. */
  async listVideoLibraries(): Promise<BunnyLibrary[]> {
    if (this.mock) return [...MOCK_LIBRARIES.values()];
    const body = await this.request<{ Items?: BunnyLibrary[] }>('/videolibrary?page=1&perPage=1000');
    return Array.isArray(body.Items) ? body.Items : [];
  }

  /** Delete a library, which is what undoes a provisioning attempt gone wrong. */
  async deleteVideoLibrary(id: number | string): Promise<void> {
    if (this.mock) {
      MOCK_LIBRARIES.delete(Number(id));
      return;
    }
    const response = await this.send(`${BUNNY_CORE_BASE}/videolibrary/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
      headers: { AccessKey: this.apiKey, accept: 'application/json' },
    });
    await this.ensureOk(response);
  }

  /**
   * The library's own CDN hostname.
   *
   * A Stream library's pull zone is named after the library and its system
   * hostname is `{name}.b-cdn.net`; both are read back rather than guessed,
   * because a renamed zone would make a guess wrong and a wrong hostname here
   * means every playback URL in the dashboard 404s.
   */
  pullZoneHostname(pullZone: BunnyPullZone): string | undefined {
    const hostnames = Array.isArray(pullZone.Hostnames) ? pullZone.Hostnames : [];
    const system = hostnames.find((entry) => entry.IsSystemHostname && entry.Value) ?? hostnames.find((entry) => entry.Value);
    const value = system?.Value?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (value) return value;
    return pullZone.Name ? `${pullZone.Name}.b-cdn.net` : undefined;
  }

  /**
   * Everything "add an account" means, in one call.
   *
   * The order matters: the library has to exist before anything can be
   * configured on it, and the pull zone is only readable once Bunny has made
   * one. A watermark image is optional — a library with no image still gets the
   * placement, so uploading the image later lands exactly where the settings
   * say (and so re-applying only has to send the image).
   *
   * Nothing here is destructive: if the placement fails after the library was
   * created, the library is left in place and the error is raised, so the
   * caller can keep the account and offer a re-apply rather than silently
   * leaving a half-made library nobody knows about.
   */
  async provisionLibrary(options: {
    name: string;
    watermark?: WatermarkPlacement;
    image?: Buffer | Uint8Array;
    imageContentType?: string;
    /** Extra fields for the create call (replication regions, player version…). */
    create?: Record<string, unknown>;
  }): Promise<ProvisionedLibrary> {
    const library = await this.createVideoLibrary(options.name, options.create ?? {});
    const libraryId = String(library.Id);
    // One settings call leaves the library whole: the resolution ladder and the
    // shared encoding flags go in every time, and the placement joins them when
    // there is one. (The create call already asks for the ladder, but Bunny was
    // asked twice here long before `ScaleVideoUsingBothDimensions` was found on
    // the update call only — and a re-sent field is cheap.)
    if (options.watermark) {
      await this.setWatermarkPlacement(libraryId, options.watermark, {
        EnabledResolutions: resolutionsValue(),
        ...LIBRARY_ENCODING_SETTINGS,
      });
    } else {
      await this.configureEncoding(libraryId);
    }
    let watermarkApplied = false;
    if (options.image && options.image.byteLength > 0) {
      await this.uploadWatermark(libraryId, options.image, options.imageContentType ?? 'image/png');
      watermarkApplied = true;
    }
    let pullZoneHost: string | undefined;
    if (library.PullZoneId !== undefined) {
      try {
        pullZoneHost = this.pullZoneHostname(await this.getPullZone(library.PullZoneId));
      } catch {
        /* a hostname is a convenience: the account works without one */
      }
    }
    const streamApiKey = typeof library.ApiKey === 'string' ? library.ApiKey : '';
    if (!streamApiKey && !this.mock) {
      throw new BunnyError('bunny.net created the library but returned no Stream API key for it');
    }
    return {
      library,
      libraryId,
      streamApiKey: streamApiKey || `mock-stream-key-${library.Id}`,
      ...(pullZoneHost ? { pullZoneHost } : {}),
      watermarkApplied,
    };
  }

  /**
   * Put back everything this dashboard owns on a library that already exists.
   *
 * The companion to [libraryDrift]: reading a library back can report a
 * narrower resolution ladder, scaling by height and width switched off, or a
 * placement that has moved, and this is the one call that makes all of them true
 * again. The placement, the ladder and the flags go in a single request; the
 * image, being a body of bytes, is its own.
   */
  async applyLibrarySettings(
    libraryId: number | string,
    options: {
      placement: WatermarkPlacement;
      resolutions?: readonly string[];
      image?: Buffer | Uint8Array;
      imageContentType?: string;
    },
  ): Promise<boolean> {
    await this.setWatermarkPlacement(libraryId, options.placement, {
      EnabledResolutions: resolutionsValue(options.resolutions ?? ALL_RESOLUTIONS),
      ...LIBRARY_ENCODING_SETTINGS,
    });
    if (!options.image || options.image.byteLength === 0) return false;
    await this.uploadWatermark(libraryId, options.image, options.imageContentType ?? 'image/png');
    return true;
  }

  /**
   * Apply the shared watermark to a library that already exists.
   *
   * This is the "fix up the accounts I already have" path: the placement is
   * re-sent and the image re-uploaded, so every library ends up with the same
   * mark in the same corner whatever it had before.
   */
  async applyWatermark(
    libraryId: number | string,
    placement: WatermarkPlacement,
    image?: Buffer | Uint8Array,
    imageContentType = 'image/png',
  ): Promise<boolean> {
    await this.setWatermarkPlacement(libraryId, placement);
    if (!image || image.byteLength === 0) return false;
    await this.uploadWatermark(libraryId, image, imageContentType);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Mock account: a library that springs into existence, watermark ready */
/* ------------------------------------------------------------------ */

const MOCK_LIBRARIES = new Map<number, BunnyLibrary>();
let MOCK_NEXT_ID = 900_000;

/**
 * A library as Bunny holds one this dashboard never configured: a ladder that
 * stops at 1080p, scaling by height and width switched off, and no watermark at
 * all — which is exactly what a library made in Bunny's own panel looks like.
 * That is what the read-back check is for, so the mock has to be able to
 * represent it.
 */
function mockHandMadeLibrary(id: number, name: string): BunnyLibrary {
  return {
    Id: id,
    Name: name,
    ApiKey: `mock-stream-key-${id}`,
    ReadOnlyApiKey: `mock-readonly-key-${id}`,
    PullZoneId: id + 500_000,
    HasWatermark: false,
    EnabledResolutions: '240p,360p,480p,720p,1080p',
    ScaleVideoUsingBothDimensions: false,
  };
}

/**
 * Create a mock library from the body the client sent, the way Bunny does.
 *
 * `Id` and `HasWatermark` are the library's own: they are Bunny's to assign, not
 * the caller's to set. Everything else the request named is stored as sent, so a
 * library this process created reads back the way it was configured.
 */
function mockCreateLibrary(name: string, body: Record<string, unknown> = {}): BunnyLibrary {
  const id = (MOCK_NEXT_ID += 1);
  const library: BunnyLibrary = {
    ...mockHandMadeLibrary(id, name),
    ...(body as Partial<BunnyLibrary>),
    Id: id,
    Name: name,
    HasWatermark: false,
  };
  MOCK_LIBRARIES.set(id, library);
  return library;
}

/**
 * The library with this id, making one up if it was never created here.
 *
 * A library added to the dashboard by hand has an id this process never issued,
 * and it is registered under *that* id so reading it twice sees the same
 * library — which is exactly what a check-then-fix-then-check does.
 */
function mockGetLibrary(id: number): BunnyLibrary {
  const existing = MOCK_LIBRARIES.get(id);
  if (existing) return existing;
  const library = mockHandMadeLibrary(id, `mock library ${id}`);
  MOCK_LIBRARIES.set(id, library);
  return library;
}

/** Merge a settings patch into the mock library, the way the core API does. */
function mockUpdateLibrary(id: number, patch: Record<string, unknown>): BunnyLibrary {
  const library = mockGetLibrary(id);
  const updated = { ...library, ...patch } as BunnyLibrary;
  MOCK_LIBRARIES.set(id, updated);
  return updated;
}

function mockPullZone(id: number): BunnyPullZone {
  return { Id: id, Name: `mock-zone-${id}`, Hostnames: [{ Value: `mock-zone-${id}.b-cdn.net`, IsSystemHostname: true }] };
}

/** A mock account starts with one library, like a real account usually has. */
mockCreateLibrary('Mock Library');
