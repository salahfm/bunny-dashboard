import assert from 'node:assert/strict';
import test from 'node:test';
import { BunnyError } from '../src/bunny';
import {
  ALL_RESOLUTIONS,
  BUNNY_CORE_BASE,
  BunnyCoreClient,
  enabledResolutionSet,
  libraryDrift,
  resolutionsValue,
  type BunnyLibrary,
  type BunnyPullZone,
} from '../src/bunny-core';

interface FakeResponse {
  status?: number;
  body?: unknown;
}

/**
 * A fetch that answers from a scripted handler and remembers every request.
 *
 * The same shape the Stream client's tests use, kept local on purpose: what is
 * asserted here is the *core* API's wire format, and a shared helper would make
 * it easy to blur the two.
 */
function captureFetch(handler: (url: string, init: RequestInit) => FakeResponse) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    const result = handler(url, requestInit);
    const status = result.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), { status });
  }) as typeof fetch;
  return { impl, calls };
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const LIBRARY: BunnyLibrary = {
  Id: 4242,
  Name: 'Feature Films',
  ApiKey: 'stream-key-abc',
  PullZoneId: 7777,
  HasWatermark: false,
  EnabledResolutions: '',
};

test('resolutionsValue joins every rung Bunny offers', () => {
  assert.equal(resolutionsValue(), ALL_RESOLUTIONS.join(','));
  assert.equal(resolutionsValue(), '240p,360p,480p,720p,1080p,1440p,2160p');
});

test('createVideoLibrary posts the name and every resolution to the core API', async () => {
  const { impl, calls } = captureFetch(() => ({ body: LIBRARY }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const library = await client.createVideoLibrary('Feature Films');
  assert.equal(library.Id, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${BUNNY_CORE_BASE}/videolibrary`);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(headersOf(calls[0]!).AccessKey, 'acct-key');
  assert.equal(headersOf(calls[0]!).accept, 'application/json');
  assert.deepEqual(bodyOf(calls[0]!), { Name: 'Feature Films', EnabledResolutions: resolutionsValue() });
});

test('configureEncoding sends the ladder as a comma-separated string, with the shared scaling flag', async () => {
  const { impl, calls } = captureFetch(() => ({ body: LIBRARY }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await client.configureEncoding(4242);
  assert.equal(calls[0]?.url, `${BUNNY_CORE_BASE}/videolibrary/4242`);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.deepEqual(bodyOf(calls[0]!), {
    EnabledResolutions: '240p,360p,480p,720p,1080p,1440p,2160p',
    ScaleVideoUsingBothDimensions: true,
  });
  // A narrower ladder is the same call with a different list — the flag is what
  // makes "scale video by height and width" on, and it travels every time.
  await client.configureEncoding(4242, ['1080p', '720p']);
  assert.deepEqual(bodyOf(calls[1]!), { EnabledResolutions: '1080p,720p', ScaleVideoUsingBothDimensions: true });
});

test('setWatermarkPlacement sends the four percentages Bunny takes', async () => {
  const { impl, calls } = captureFetch(() => ({ body: LIBRARY }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await client.setWatermarkPlacement(4242, { left: 86, top: 90, width: 12, height: 8 });
  assert.deepEqual(bodyOf(calls[0]!), {
    WatermarkPositionLeft: 86,
    WatermarkPositionTop: 90,
    WatermarkWidth: 12,
    WatermarkHeight: 8,
  });
});

test('uploadWatermark puts the raw image on the wire with its length and type', async () => {
  const { impl, calls } = captureFetch(() => ({ status: 204 }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const image = Buffer.from('PNG-BYTES');
  await client.uploadWatermark(4242, image, 'image/png');
  assert.equal(calls[0]?.url, `${BUNNY_CORE_BASE}/videolibrary/4242/watermark`);
  assert.equal(calls[0]?.init.method, 'PUT');
  assert.equal(headersOf(calls[0]!)['content-type'], 'image/png');
  assert.equal(headersOf(calls[0]!)['content-length'], String(image.byteLength));
  const body = calls[0]?.init.body as Buffer;
  assert.ok(Buffer.isBuffer(body), 'the image goes on the wire as bytes, not JSON');
  assert.equal(body.toString(), 'PNG-BYTES');
});

test('an image Bunny will not take as-is is retried as a bare octet-stream', async () => {
  // The call's body format is undocumented, so a 400 must not be the end of it:
  // the second framing is the one Bunny will accept.
  let attempt = 0;
  const { impl, calls } = captureFetch(() => {
    attempt += 1;
    return attempt === 1 ? { status: 400, body: { message: 'The request body is empty or invalid' } } : { status: 204 };
  });
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await client.uploadWatermark(4242, Buffer.from('PNG'), 'image/png');
  assert.equal(calls.length, 2);
  assert.equal(headersOf(calls[0]!)['content-type'], 'image/png');
  assert.equal(headersOf(calls[1]!)['content-type'], 'application/octet-stream');
  assert.equal((calls[1]?.init.body as Buffer).toString(), 'PNG', 'the same bytes go up both times');
});

test('a retried image that is still refused raises Bunny\'s message', async () => {
  const { impl, calls } = captureFetch(() => ({ status: 415, body: { message: 'Unsupported media type' } }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await assert.rejects(
    () => client.uploadWatermark(4242, Buffer.from('PNG'), 'image/png'),
    (error: unknown) => error instanceof BunnyError && /Unsupported media type/.test(error.message),
  );
  assert.equal(calls.length, 2, 'tried both framings, then stopped');
});

test('a refused key is not re-sent with a different content type', async () => {
  // 401 says the credential is wrong, not the label on the body.
  const { impl, calls } = captureFetch(() => ({ status: 401, body: {} }));
  const client = new BunnyCoreClient({ apiKey: 'a-library-key', fetchImpl: impl, retries: 0 });
  await assert.rejects(() => client.uploadWatermark(4242, Buffer.from('PNG')));
  assert.equal(calls.length, 1);
});

test('deleteVideoLibrary is a DELETE against the library', async () => {
  const { impl, calls } = captureFetch(() => ({ status: 204 }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await client.deleteVideoLibrary(4242);
  assert.equal(calls[0]?.url, `${BUNNY_CORE_BASE}/videolibrary/4242`);
  assert.equal(calls[0]?.init.method, 'DELETE');
});

test('provisionLibrary creates, places, uploads and reads the pull zone back', async () => {
  const { impl, calls } = captureFetch((url) => {
    if (url.endsWith('/videolibrary')) return { body: LIBRARY };
    if (url.endsWith('/watermark')) return { status: 204 };
    if (url.includes('/pullzone/')) {
      const zone: BunnyPullZone = { Id: 7777, Name: 'feat', Hostnames: [{ Value: 'vz-feat.b-cdn.net', IsSystemHostname: true }] };
      return { body: zone };
    }
    return { body: LIBRARY };
  });
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const image = Buffer.from('PNG');
  const provisioned = await client.provisionLibrary({
    name: 'Feature Films',
    watermark: { left: 86, top: 90, width: 12, height: 8 },
    image,
    imageContentType: 'image/png',
  });

  // A read sends no explicit method, which is a GET on the wire; the writer
  // still names itself so the sequence is unambiguous.
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? 'GET'} ${call.url.replace(BUNNY_CORE_BASE, '')}`),
    [
      'POST /videolibrary',
      'POST /videolibrary/4242',
      'PUT /videolibrary/4242/watermark',
      'GET /pullzone/7777',
    ],
  );
  assert.equal(provisioned.libraryId, '4242');
  assert.equal(provisioned.streamApiKey, 'stream-key-abc');
  assert.equal(provisioned.pullZoneHost, 'vz-feat.b-cdn.net');
  assert.equal(provisioned.watermarkApplied, true);
  // The placement call carries the resolution ladder too, so one request leaves
  // the library whole rather than two.
  assert.deepEqual(bodyOf(calls[1]!), {
    WatermarkPositionLeft: 86,
    WatermarkPositionTop: 90,
    WatermarkWidth: 12,
    WatermarkHeight: 8,
    EnabledResolutions: resolutionsValue(),
    ScaleVideoUsingBothDimensions: true,
  });
});

test('provisionLibrary with no image still configures the library', async () => {
  const { impl, calls } = captureFetch((url) => {
    if (url.endsWith('/videolibrary')) return { body: LIBRARY };
    if (url.includes('/pullzone/')) return { body: { Id: 7777, Hostnames: [] } };
    return { body: LIBRARY };
  });
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const provisioned = await client.provisionLibrary({ name: 'Feature Films', watermark: { left: 2, top: 2, width: 10, height: 6 } });
  assert.equal(provisioned.watermarkApplied, false);
  assert.equal(provisioned.streamApiKey, 'stream-key-abc');
  // The library came back with no hostname, so the url points at a bare zone name.
  assert.equal(provisioned.pullZoneHost, undefined);
  assert.ok(!calls.some((call) => call.url.endsWith('/watermark')), 'no image means no upload');
  assert.ok(calls.some((call) => bodyOf(call).ScaleVideoUsingBothDimensions === true), 'the scaling flag goes on every library');
});

test('a library Bunny made without a Stream key is refused rather than stored', async () => {
  const { impl } = captureFetch(() => ({ body: { Id: 4242, Name: 'Feature Films', EnabledResolutions: '' } }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await assert.rejects(
    () => client.provisionLibrary({ name: 'Feature Films' }),
    (error: unknown) => error instanceof BunnyError && /no Stream API key/.test(error.message),
  );
});

test('a 401 explains that the account key was the one needed', async () => {
  const { impl } = captureFetch(() => ({ status: 401, body: {} }));
  const client = new BunnyCoreClient({ apiKey: 'a-library-key', fetchImpl: impl, retries: 0 });
  await assert.rejects(
    () => client.createVideoLibrary('Feature Films'),
    (error: unknown) => {
      assert.ok(error instanceof BunnyError);
      assert.equal(error.status, 401);
      assert.match(error.message, /account API key/);
      return true;
    },
  );
});

test('a refusal that is Bunny\'s own verdict keeps the message it sent', async () => {
  const { impl } = captureFetch(() => ({ status: 400, body: { message: 'The request body is invalid' } }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  await assert.rejects(
    () => client.getVideoLibrary(1),
    (error: unknown) => {
      assert.ok(error instanceof BunnyError);
      assert.equal(error.status, 400);
      assert.match(error.message, /The request body is invalid/);
      return true;
    },
  );
});

test('a 5xx is a transport problem, retried rather than ruled on', async () => {
  // The shared policy retries a server error and only gives up after the
  // attempts are spent, which is exactly what a hung Bunny API looks like.
  const { impl, calls } = captureFetch(() => ({ status: 503 }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 1 });
  await assert.rejects(
    () => client.createVideoLibrary('Feature Films'),
    (error: unknown) => {
      assert.ok(error instanceof BunnyError);
      assert.equal(error.status, 503);
      assert.match(error.message, /could not be reached after 2 attempt/);
      return true;
    },
  );
  assert.equal(calls.length, 2, 'one attempt plus one retry');
});

test('pullZoneHostname prefers the system hostname and falls back to the zone name', () => {
  const client = new BunnyCoreClient({ apiKey: 'acct-key', mock: true });
  assert.equal(
    client.pullZoneHostname({ Id: 1, Name: 'zone', Hostnames: [{ Value: 'custom.example.com' }, { Value: 'vz-abc.b-cdn.net', IsSystemHostname: true }] }),
    'vz-abc.b-cdn.net',
  );
  // No hostnames at all: the zone's own name is the documented shape.
  assert.equal(client.pullZoneHostname({ Id: 1, Name: 'vz-abc', Hostnames: [] }), 'vz-abc.b-cdn.net');
  // A scheme in the stored value is stripped: playback URLs add their own.
  assert.equal(client.pullZoneHostname({ Id: 1, Hostnames: [{ Value: 'https://vz-abc.b-cdn.net/' }] }), 'vz-abc.b-cdn.net');
  assert.equal(client.pullZoneHostname({ Id: 1, Hostnames: [] }), undefined);
});

/* ------------------------------------------------------------------ */
/* Reading a library back                                               */
/* ------------------------------------------------------------------ */

/** A library that holds exactly what the dashboard asks for. */
const IN_SYNC: BunnyLibrary = {
  Id: 4242,
  EnabledResolutions: resolutionsValue(),
  HasWatermark: true,
  WatermarkPositionLeft: 86,
  WatermarkPositionTop: 90,
  WatermarkWidth: 12,
  WatermarkHeight: 8,
  ScaleVideoUsingBothDimensions: true,
};

const EXPECTED = {
  resolutions: ALL_RESOLUTIONS,
  watermark: { left: 86, top: 90, width: 12, height: 8 },
  expectImage: true,
  scaleByBothDimensions: true,
};

test('enabledResolutionSet reads the comma-separated string however it is written', () => {
  assert.deepEqual([...enabledResolutionSet('240p, 360p ,720P')], ['240p', '360p', '720p']);
  assert.deepEqual([...enabledResolutionSet('')], []);
  assert.deepEqual([...enabledResolutionSet(undefined)], []);
});

test('a library that matches the settings has no findings', () => {
  assert.deepEqual(libraryDrift(IN_SYNC, EXPECTED), []);
  // And a library that says nothing about its bullets is not drift it was not asked about.
  assert.deepEqual(
    libraryDrift({ Id: 1, EnabledResolutions: resolutionsValue() }, { resolutions: ALL_RESOLUTIONS, scaleByBothDimensions: false }),
    [],
  );
});

test('scaling by height and width is checked the same way the ladder is', () => {
  const off = libraryDrift({ ...IN_SYNC, ScaleVideoUsingBothDimensions: false }, EXPECTED);
  assert.equal(off.length, 1);
  assert.equal(off[0]?.field, 'encoding');
  assert.match(off[0]!.message, /not scaled using both dimensions/);
  assert.equal(off[0]?.actual, 'Bunny holds false');
  // A library Bunny said nothing about stands the same way an empty resolution
  // ladder does: unconfirmed, not fine.
  const silent = libraryDrift({ ...IN_SYNC, ScaleVideoUsingBothDimensions: undefined }, EXPECTED);
  assert.equal(silent.length, 1);
  assert.equal(silent[0]?.field, 'encoding');
  assert.equal(silent[0]?.actual, 'Bunny did not report it');
});

test('a narrower resolution ladder is reported with the rungs that are missing', () => {
  const findings = libraryDrift({ ...IN_SYNC, EnabledResolutions: '240p,360p,480p,720p,1080p' }, EXPECTED);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.field, 'resolutions');
  assert.equal(findings[0]?.message, 'missing 1440p, 2160p');
  assert.equal(findings[0]?.actual, '240p,360p,480p,720p,1080p');
});

test('a library Bunny will not describe is reported rather than assumed fine', () => {
  const findings = libraryDrift(
    { Id: 1, EnabledResolutions: '', ScaleVideoUsingBothDimensions: true },
    { resolutions: ALL_RESOLUTIONS },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.field, 'resolutions');
  assert.match(findings[0]!.message, /could not be confirmed/);
});

test('a mark that has moved is drift; one Bunny rounded is not', () => {
  // Half a percentage point is Bunny rounding what it stored.
  assert.deepEqual(libraryDrift({ ...IN_SYNC, WatermarkPositionLeft: 86.4 }, EXPECTED), []);
  // A whole different corner is not.
  const findings = libraryDrift({ ...IN_SYNC, WatermarkPositionLeft: 2, WatermarkPositionTop: 2 }, EXPECTED);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.field, 'watermark-placement');
  assert.match(findings[0]!.message, /expected left 86%, top 90%, width 12%, height 8%/);
  assert.match(findings[0]!.message, /Bunny holds left 2%, top 2%, width 12%, height 8%/);
});

test('a placement Bunny never reported at all is drift', () => {
  const bare: BunnyLibrary = { Id: 1, EnabledResolutions: resolutionsValue(), HasWatermark: false, ScaleVideoUsingBothDimensions: true };
  const findings = libraryDrift(bare, EXPECTED);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.field), ['watermark-placement', 'watermark-image']);
  assert.match(findings[0]!.message, /Bunny holds left —, top —, width —, height —/);
});

test('the image is checked for presence, both ways round', () => {
  const expected = { ...EXPECTED, expectImage: false };
  assert.deepEqual(libraryDrift({ ...IN_SYNC, HasWatermark: false }, expected), []);
  const findings = libraryDrift(IN_SYNC, expected);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.field, 'watermark-image');
  assert.match(findings[0]!.message, /did not upload/);

  const missing = libraryDrift({ ...IN_SYNC, HasWatermark: false }, EXPECTED);
  assert.equal(missing.length, 1);
  assert.match(missing[0]!.message, /holds no watermark image/);
});

test('applyLibrarySettings sends the ladder and the placement in one request, then the image', async () => {
  const { impl, calls } = captureFetch((url) => (url.endsWith('/watermark') ? { status: 204 } : { body: IN_SYNC }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const uploaded = await client.applyLibrarySettings(4242, {
    placement: { left: 86, top: 90, width: 12, height: 8 },
    image: Buffer.from('PNG'),
  });
  assert.equal(uploaded, true);
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? 'GET'} ${call.url.replace(BUNNY_CORE_BASE, '')}`),
    ['POST /videolibrary/4242', 'PUT /videolibrary/4242/watermark'],
  );
  assert.deepEqual(bodyOf(calls[0]!), {
    WatermarkPositionLeft: 86,
    WatermarkPositionTop: 90,
    WatermarkWidth: 12,
    WatermarkHeight: 8,
    EnabledResolutions: resolutionsValue(),
    ScaleVideoUsingBothDimensions: true,
  });
});

test('applyLibrarySettings with no image fixes the ladder and placement only', async () => {
  const { impl, calls } = captureFetch(() => ({ body: IN_SYNC }));
  const client = new BunnyCoreClient({ apiKey: 'acct-key', fetchImpl: impl, retries: 0 });
  const uploaded = await client.applyLibrarySettings(4242, {
    placement: { left: 86, top: 90, width: 12, height: 8 },
    resolutions: ['1080p', '720p'],
  });
  assert.equal(uploaded, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(bodyOf(calls[0]!), {
    WatermarkPositionLeft: 86,
    WatermarkPositionTop: 90,
    WatermarkWidth: 12,
    WatermarkHeight: 8,
    EnabledResolutions: '1080p,720p',
    ScaleVideoUsingBothDimensions: true,
  });
});

test('mock mode provisions a library without touching the network', async () => {
  const impl = (async () => {
    throw new Error('mock mode must not call the network');
  }) as typeof fetch;
  const client = new BunnyCoreClient({ apiKey: 'acct-key', mock: true, fetchImpl: impl });
  const provisioned = await client.provisionLibrary({
    name: 'Mock Library',
    watermark: { left: 86, top: 90, width: 12, height: 8 },
    image: Buffer.from('PNG'),
  });
  assert.match(provisioned.libraryId, /^9\d{5}$/);
  assert.ok(provisioned.streamApiKey.length > 0);
  assert.equal(provisioned.watermarkApplied, true);
  assert.match(String(provisioned.pullZoneHost), /\.b-cdn\.net$/);

  // The mock library records what it was told, which is what lets the read-back
  // check be exercised — and trusted — without Bunny credentials.
  const placement = { left: 86, top: 90, width: 12, height: 8 };
  const readBack = await client.getVideoLibrary(provisioned.libraryId);
  assert.deepEqual(
    libraryDrift(readBack, { resolutions: ALL_RESOLUTIONS, watermark: placement, expectImage: true }),
    [],
    'a provisioned mock library reads back exactly as configured',
  );
  // A library this dashboard never configured reports all four differences: its
  // ladder stops short, scaling by height and width is off, its mark is nowhere,
  // and it has no image.
  const untouched = await client.getVideoLibrary('424242');
  assert.deepEqual(
    libraryDrift(untouched, { resolutions: ALL_RESOLUTIONS, watermark: placement, expectImage: true }).map((finding) => finding.field),
    ['resolutions', 'encoding', 'watermark-placement', 'watermark-image'],
  );
  // And the fix is what clears it, read back rather than assumed.
  await client.applyLibrarySettings(untouched.Id, { placement });
  assert.deepEqual(
    libraryDrift(await client.getVideoLibrary(untouched.Id), { resolutions: ALL_RESOLUTIONS, watermark: placement, expectImage: true }).map(
      (finding) => finding.field,
    ),
    ['watermark-image'],
  );
});
