import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeepLRequest,
  createTranslator,
  DEEPL_WEB_ENDPOINT,
  deepLTimestamp,
  planChunks,
  readDeepLTexts,
  TranslationError,
} from '../src/translate';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  /** The raw body, so the `"method"` whitespace quirk can be checked. */
  raw: string;
  body: {
    id: number;
    method: string;
    params: {
      texts: Array<{ text: string }>;
      splitting: string;
      lang: { source_lang_user_selected: string; target_lang: string };
      timestamp: number;
    };
  };
}

/** A stand-in for `www2.deepl.com`: same request shape, prefixed answers. */
function fakeDeepL(calls: Call[]): typeof fetch {
  return (async (url: unknown, init: RequestInit) => {
    const raw = String(init.body);
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, raw, body: JSON.parse(raw) });
    return jsonResponse({ result: { texts: calls[calls.length - 1]!.body.params.texts.map((entry) => ({ text: `ar:${entry.text}` })) } });
  }) as unknown as typeof fetch;
}

/** Any id from the range the real client uses, chosen to hit a given shape. */
function idWhere(spaced: boolean): number {
  for (let id = 8_300_000_001; id < 8_300_010_000; id += 1) {
    const matches = (id + 5) % 29 === 0 || (id + 3) % 13 === 0;
    if (matches === spaced) return id;
  }
  throw new Error('no id found');
}

test('every cue goes to DeepL in one request, in order, with the subtitle shape', async () => {
  const calls: Call[] = [];
  const translator = createTranslator({ timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));

  const out = await translator.translate(['one', 'two'], 'ar', 'en');

  assert.deepEqual(out, ['ar:one', 'ar:two']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DEEPL_WEB_ENDPOINT);
  // No key of any kind travels with the request.
  assert.ok(!Object.keys(calls[0]?.headers ?? {}).some((header) => /authorization|api[-_]?key/i.test(header)), JSON.stringify(calls[0]?.headers));
  // A bare fetch looks like a scraper; the request says it is DeepL's own app.
  assert.match(String(calls[0]?.headers['user-agent']), /^DeepL-iOS\//);
  assert.equal(calls[0]?.body.method, 'LMT_handle_texts');
  assert.equal(calls[0]?.body.params.splitting, 'newlines');
  assert.deepEqual(calls[0]?.body.params.texts, [{ text: 'one', requestAlternatives: 0 }, { text: 'two', requestAlternatives: 0 }]);
  // A lowercase source and an uppercase target, the way the site sends them.
  assert.equal(calls[0]?.body.params.lang.source_lang_user_selected, 'en');
  assert.equal(calls[0]?.body.params.lang.target_lang, 'AR');
  assert.equal(typeof calls[0]?.body.params.timestamp, 'number');
});

test('the source language is left to DeepL when the caller does not know it', async () => {
  const calls: Call[] = [];
  const translator = createTranslator({ timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));
  await translator.translate(['hi'], 'ar');
  assert.equal(calls[0]?.body.params.lang.source_lang_user_selected, 'auto');
});

test('the "method" whitespace follows the id, the way the site writes it', () => {
  const call = (id: number): string =>
    buildDeepLRequest({ texts: ['hello'], target: 'ar', source: 'en', id, timestamp: 1 }).slice(0, 80);
  assert.match(call(idWhere(true)), /"method" : "LMT_handle_texts"/);
  assert.match(call(idWhere(false)), /"method": "LMT_handle_texts"/);
});

test('the timestamp carries the i-count adjustment the endpoint expects', () => {
  const now = 1_700_000_000_000;
  assert.equal(deepLTimestamp('hello there', now), now, 'no letter i means no adjustment');
  const adjusted = deepLTimestamp('iii', now);
  assert.equal(adjusted % 4, 0, 'aligned to the letter count plus one');
  assert.ok(adjusted >= now);
});

test('a long cue list is split, and the order survives the round trip', async () => {
  const calls: Call[] = [];
  const translator = createTranslator({ timeoutMs: 1_000, retries: 0, paceMs: 0 }, fakeDeepL(calls));

  const cues = Array.from({ length: 45 }, (_, index) => `cue ${index}`);
  const out = await translator.translate(cues, 'ar', 'en');

  assert.equal(calls.length, 2, '45 cues go over a 25-cue chunk size');
  assert.equal(calls[0]?.body.params.texts.length, 25);
  assert.equal(calls[1]?.body.params.texts.length, 20);
  assert.deepEqual(out, cues.map((cue) => `ar:${cue}`));
});

test('an oversized cue travels alone instead of being split', () => {
  const texts = ['x'.repeat(9_000), 'short'];
  assert.deepEqual(planChunks(texts), [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
});

test('a blank cue is never sent as a translation and keeps its own text', async () => {
  const calls: Call[] = [];
  const translator = createTranslator({ timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));
  const out = await translator.translate(['one', '   ', 'two'], 'ar', 'en');
  assert.deepEqual(out, ['ar:one', '   ', 'ar:two']);
});

test('a reply with the wrong number of cues is refused, not silently misaligned', () => {
  assert.throws(() => readDeepLTexts({ result: { texts: [{ text: 'only one' }] } }, 2), TranslationError);
});

test('a refusal from DeepL surfaces as a translation error, not a crash', async () => {
  const fetchImpl = (async () => jsonResponse({ error: { code: -32600, message: 'Invalid targetLang' } })) as unknown as typeof fetch;
  const translator = createTranslator({ timeoutMs: 1_000, retries: 0 }, fetchImpl);
  await assert.rejects(translator.translate(['one'], 'ar', 'en'), (error: unknown) => {
    assert.ok(error instanceof TranslationError);
    assert.match(error.message, /Invalid targetLang/);
    return true;
  });
});

test('a non-JSON or empty answer is reported rather than half-parsed', async () => {
  const html = (async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }) as unknown as Response) as unknown as typeof fetch;
  await assert.rejects(createTranslator({ timeoutMs: 1_000, retries: 0 }, html).translate(['one'], 'ar'), TranslationError);
});

test('an HTTP refusal names the status instead of "fetch failed"', async () => {
  const throttled = (async () => jsonResponse({ error: { message: 'Too many requests' } }, 403)) as unknown as typeof fetch;
  await assert.rejects(createTranslator({ timeoutMs: 1_000, retries: 0 }, throttled).translate(['one'], 'ar'), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : '', /HTTP 403/);
    return true;
  });
});

test('the endpoint can be pointed somewhere else', async () => {
  const calls: Call[] = [];
  const translator = createTranslator({ endpoint: 'http://127.0.0.1:9/jsonrpc', timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));
  await translator.translate(['hi'], 'ar');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:9/jsonrpc');
});

test('mock mode answers on this machine, and a named endpoint still wins', async () => {
  const calls: Call[] = [];
  const mock = createTranslator({ mock: true, timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));
  // One translation per cue, in order, blanks untouched — the contract the real
  // engine keeps, minus the network.
  assert.deepEqual(await mock.translate(['one', '  ', 'two'], 'ar', 'en'), ['[AR] one', '  ', '[AR] two']);
  assert.equal(mock.provider, 'mock');
  assert.equal(calls.length, 0, 'mock mode never reaches the web endpoint');

  // Naming an endpoint is a deliberate choice, so mock mode does not bypass it.
  const pointed = createTranslator({ mock: true, endpoint: 'http://127.0.0.1:9/jsonrpc', timeoutMs: 1_000, retries: 0 }, fakeDeepL(calls));
  await pointed.translate(['hi'], 'ar');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:9/jsonrpc');
});
