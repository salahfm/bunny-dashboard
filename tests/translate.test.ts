import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator, TranslationError } from '../src/translate';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** An OpenAI-compatible endpoint that prefixes every cue it is handed. */
function fakeModel(calls: Call[]): typeof fetch {
  return (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body });
    const cues = JSON.parse(body.messages[1].content).cues as string[];
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: cues.map((cue) => `ar:${cue}`) }) } }] });
  }) as unknown as typeof fetch;
}

function fakeDeepL(calls: Call[]): typeof fetch {
  return (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body });
    return jsonResponse({ translations: (body.text as string[]).map((text) => ({ text: `ar:${text}` })) });
  }) as unknown as typeof fetch;
}

test('the model translator sends every cue and gets them back in order', async () => {
  const calls: Call[] = [];
  const translator = createTranslator(
    { provider: 'openai', apiKey: 'k', model: 'a-model', baseUrl: 'https://api.example/v1', timeoutMs: 1_000, retries: 0 },
    fakeModel(calls),
  );
  assert.ok(translator);

  const out = await translator.translate(['one', 'two'], 'ar', 'en');
  assert.deepEqual(out, ['ar:one', 'ar:two']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.example/v1/chat/completions');
  assert.equal(calls[0]?.headers.authorization, 'Bearer k');
  assert.equal(calls[0]?.body.model, 'a-model');
  // The instruction has to be the subtitle-specific one, not a generic "translate".
  assert.match(String(calls[0]?.body.messages[0].content), /subtitle translator/i);
  assert.match(String(calls[0]?.body.messages[0].content), /Modern Standard Arabic/i);
});

test('a long cue list is translated in chunks, order preserved', async () => {
  const calls: Call[] = [];
  const translator = createTranslator(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example/v1', timeoutMs: 1_000, retries: 0 },
    fakeModel(calls),
  );
  assert.ok(translator);

  const cues = Array.from({ length: 45 }, (_, index) => `cue ${index}`);
  const out = await translator.translate(cues, 'ar', 'en');

  assert.equal(calls.length, 2, '45 cues go over a 40-cue chunk size');
  assert.equal(calls[0]?.body.messages[1].content ? JSON.parse(calls[0].body.messages[1].content).cues.length : 0, 40);
  assert.equal(calls[1]?.body.messages[1].content ? JSON.parse(calls[1].body.messages[1].content).cues.length : 0, 5);
  assert.deepEqual(out, cues.map((cue) => `ar:${cue}`));
});

test('a reply with the wrong number of cues is refused, not silently misaligned', async () => {
  const fetchImpl = (async () =>
    jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: ['only one'] }) } }] })) as unknown as typeof fetch;
  const translator = createTranslator(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example/v1', timeoutMs: 1_000, retries: 0 },
    fetchImpl,
  );
  assert.ok(translator);
  await assert.rejects(translator.translate(['one', 'two'], 'ar', 'en'), TranslationError);
});

test('DeepL is aimed at the free or the paid host from the key itself', async () => {
  const free: Call[] = [];
  const freeTranslator = createTranslator({ provider: 'deepl', apiKey: 'abc:fx', timeoutMs: 1_000, retries: 0 }, fakeDeepL(free));
  assert.ok(freeTranslator);
  assert.deepEqual(await freeTranslator.translate(['hi'], 'ar', 'en'), ['ar:hi']);
  assert.equal(free[0]?.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(free[0]?.body.target_lang, 'AR');
  assert.equal(free[0]?.body.source_lang, 'EN');
  assert.match(String(free[0]?.headers.authorization), /^DeepL-Auth-Key abc:fx$/);

  const paid: Call[] = [];
  const paidTranslator = createTranslator({ provider: 'deepl', apiKey: 'abc', timeoutMs: 1_000, retries: 0 }, fakeDeepL(paid));
  assert.ok(paidTranslator);
  await paidTranslator.translate(['hi'], 'ar');
  assert.equal(paid[0]?.url, 'https://api.deepl.com/v2/translate');
  assert.equal(paid[0]?.body.source_lang, undefined, 'no source language is claimed when none is known');
});

test('a translator needs a key to exist at all', () => {
  assert.equal(createTranslator(undefined), undefined);
  assert.equal(createTranslator({ provider: 'openai', apiKey: '   ', timeoutMs: 1_000, retries: 0 }), undefined);
});

test('a refusal from the service surfaces as a translation error, not a crash', async () => {
  const fetchImpl = (async () => jsonResponse({ error: { message: 'quota exceeded' } }, 400)) as unknown as typeof fetch;
  const translator = createTranslator(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example/v1', timeoutMs: 1_000, retries: 0 },
    fetchImpl,
  );
  assert.ok(translator);
  await assert.rejects(translator.translate(['one'], 'ar', 'en'), (error: unknown) => {
    assert.ok(error instanceof TranslationError);
    assert.match(error.message, /quota exceeded/);
    return true;
  });
});

test('a model reply that is prose with JSON inside is still understood', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      choices: [{ message: { content: 'Sure! Here you go:\n```json\n{"translations":["واحد"]}\n```' } }],
    })) as unknown as typeof fetch;
  const translator = createTranslator(
    { provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example/v1', timeoutMs: 1_000, retries: 0 },
    fetchImpl,
  );
  assert.ok(translator);
  assert.deepEqual(await translator.translate(['one'], 'ar', 'en'), ['واحد']);
});
