/**
 * Subtitle text translation — DeepL, and nothing else.
 *
 * When a title arrives with English subtitles and no Arabic, the English cue
 * *text* is translated and the result uploaded to Bunny as a normal Arabic
 * caption, with the original timings untouched. Nothing listens to the audio:
 * bunny.net's own translate runs Whisper over the audio first, which is speech
 * recognition rather than translation.
 *
 * There is exactly one engine and no key. The request goes to the endpoint
 * deepl.com's own translator page calls — `www2.deepl.com/jsonrpc`, JSON-RPC
 * `LMT_handle_texts` — so a fresh install can produce Arabic subtitles with
 * nothing to sign up for and nothing to configure.
 *
 * The trade-off is that this is not a published API. DeepL can change the shape,
 * rate-limit it or refuse it at any time, which is why a refusal is *noted on the
 * job* rather than allowed to fail the publish, and why the whole engine can be
 * switched off with `SUBTITLE_TRANSLATOR=off`. A keyed account (the official
 * API) is deliberately not used.
 *
 * Only cue text is ever sent. Cue count, order and timings stay exactly as the
 * source had them, so the Arabic track stays in sync by construction.
 */
import { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS, fetchWithPolicy, NetworkError } from './net';

/** The endpoint deepl.com's translator page posts to. */
export const DEEPL_WEB_ENDPOINT = 'https://www2.deepl.com/jsonrpc';

export interface TranslatorConfig {
  /** Overrides the endpoint (a proxy, or a test server standing in for DeepL). */
  endpoint?: string;
  timeoutMs: number;
  retries: number;
  /** Wait between requests, so a long cue list does not look like a flood. */
  paceMs?: number;
  /**
   * Mock mode: answer on this machine instead of calling deepl.com, so a demo
   * or a smoke run never depends on the web endpoint. An explicitly configured
   * [endpoint] still wins, because naming one is a deliberate choice (a proxy,
   * or a test's fake DeepL) rather than an accident of the mode.
   */
  mock?: boolean;
}

export interface Translator {
  readonly provider: 'deepl' | 'mock';
  /** One translation per input string, in the same order. */
  translate(texts: string[], targetLanguage: string, sourceLanguage?: string): Promise<string[]>;
}

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

/** Cue texts per request: enough to be efficient, small enough to be accepted. */
const MAX_CUES_PER_REQUEST = 25;

/** Characters per request, near the site's own 5000-character form limit. */
const MAX_CHARS_PER_REQUEST = 4_000;

/** The gap between two requests when a subtitle file needs several. */
const DEFAULT_PACE_MS = 250;

/**
 * What the endpoint is told this client is.
 *
 * DeepL's own mobile app speaks the same JSON-RPC, and saying so is what keeps
 * the request looking like a first-party one — a bare `fetch` with no user agent
 * is the shape a scraper's requests get refused in.
 */
const DEEPL_CLIENT_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-app-os-name': 'iOS',
  'x-app-os-version': '16.3.0',
  'x-app-device': 'iPhone13,2',
  'x-app-version': '2.9.1',
  'x-app-build': '510265',
  'user-agent': 'DeepL-iOS/2.9.1 iOS 16.3.0 (iPhone13,2)',
};

export interface DeepLRequestInit {
  texts: string[];
  target: string;
  source?: string;
  id: number;
  timestamp: number;
}

/**
 * The JSON body for one `LMT_handle_texts` call, in the exact shape the site
 * sends.
 *
 * Two details are load-bearing. `splitting: 'newlines'` keeps a cue's own line
 * break as a line break instead of letting the engine reflow it into a wall of
 * text. And the whitespace around `"method"` is not cosmetic: the site's own
 * client writes a different spacing for some ids, and the endpoint refuses the
 * request when it does not match.
 */
export function buildDeepLRequest(init: DeepLRequestInit): string {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'LMT_handle_texts',
    id: init.id,
    params: {
      texts: init.texts.map((text) => ({ text, requestAlternatives: 0 })),
      splitting: 'newlines',
      lang: {
        // The site's own client sends a lowercase source and an uppercase target.
        source_lang_user_selected: init.source ? init.source.toLowerCase() : 'auto',
        target_lang: init.target.toUpperCase(),
      },
      timestamp: init.timestamp,
      commonJobParams: { wasSpoken: false, transcribe_as: '' },
    },
  });
  const spaced = (init.id + 5) % 29 === 0 || (init.id + 3) % 13 === 0;
  return body.replace('"method":"', spaced ? '"method" : "' : '"method": "');
}

/**
 * The timestamp the site's client sends.
 *
 * It is nudged to a multiple of the letter `i` count plus one — a quirk of their
 * client that the endpoint appears to expect, so it is reproduced rather than
 * questioned.
 */
export function deepLTimestamp(text: string, now: number = Date.now()): number {
  const iCount = (text.match(/i/g) ?? []).length;
  if (iCount === 0) return now;
  const divisor = iCount + 1;
  return now - (now % divisor) + divisor;
}

/** An id in the range the site's client uses. */
function randomCallId(): number {
  return (Math.floor(Math.random() * 99_999) + 8_300_000) * 1_000 + 1;
}

/**
 * The translations out of an `LMT_handle_texts` reply, one per text in order.
 *
 * The live text is `result.texts[i].text`, with `result.texts[i].alternatives`
 * as also-rans. A reply whose count does not match the request is refused rather
 * than stitched back onto the cues — a misaligned Arabic track is worse than
 * none.
 */
export function readDeepLTexts(payload: unknown, expected: number): string[] {
  const texts = (payload as { result?: { texts?: unknown } } | undefined)?.result?.texts;
  if (!Array.isArray(texts)) throw new TranslationError('DeepL did not answer with a translation');
  const out = texts.map((entry) => {
    const record = entry as { text?: unknown; alternatives?: Array<{ text?: unknown }> } | undefined;
    if (typeof record?.text === 'string' && record.text.trim()) return record.text;
    const alternative = record?.alternatives?.[0]?.text;
    return typeof alternative === 'string' ? alternative : '';
  });
  if (out.length !== expected) {
    throw new TranslationError(`DeepL returned ${out.length} translations for ${expected} cues`);
  }
  return out;
}

/** Contiguous ranges of the cue list, split on count and total length. */
export function planChunks(texts: string[]): Array<{ start: number; end: number }> {
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  let chars = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const length = (texts[index] ?? '').length;
    // An oversized single cue still travels alone rather than being split.
    if (index > start && (index - start >= MAX_CUES_PER_REQUEST || chars + length > MAX_CHARS_PER_REQUEST)) {
      chunks.push({ start, end: index });
      start = index;
      chars = 0;
    }
    chars += length;
  }
  chunks.push({ start, end: texts.length });
  return chunks;
}

interface EngineOptions {
  config: TranslatorConfig;
  fetchImpl: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One request's worth of cues, in order. */
async function requestChunk(options: EngineOptions, texts: string[], target: string, source?: string): Promise<string[]> {
  const init: DeepLRequestInit = {
    texts,
    target,
    ...(source ? { source } : {}),
    id: randomCallId(),
    timestamp: deepLTimestamp(texts.join('\n')),
  };

  let response: Response;
  try {
    response = await fetchWithPolicy(
      options.config.endpoint ?? DEEPL_WEB_ENDPOINT,
      { method: 'POST', headers: DEEPL_CLIENT_HEADERS, body: buildDeepLRequest(init) },
      {
        what: 'DeepL',
        fetchImpl: options.fetchImpl,
        timeoutMs: options.config.timeoutMs,
        retries: options.config.retries,
        // A 429 here means "you are going too fast", so back off further than
        // a normal retry would.
        backoffMs: 1_500,
      },
    );
  } catch (error) {
    if (error instanceof NetworkError) {
      // A rate limit is not a reachability problem, and it says something a job
      // note should repeat: the machine is asking DeepL too often.
      throw new TranslationError(
        error.status === 429
          ? 'DeepL is rate-limiting this machine (HTTP 429) — translation for this title was skipped'
          : error.message,
      );
    }
    throw error;
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON — the messages below cope */
  }

  if (!response.ok) {
    const detail = (payload as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
    throw new TranslationError(`DeepL refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const refusal = (payload as { error?: { message?: string } } | undefined)?.error?.message;
  if (refusal) throw new TranslationError(`DeepL refused the request: ${refusal}`);

  return readDeepLTexts(payload, texts.length);
}

/**
 * Mock mode's engine: the same text-only contract, answered locally.
 *
 * `npm run mock` exists so the whole pipeline can run without touching a real
 * provider — TMDB, Bunny and, here, deepl.com. The stand-in text wears its
 * language as a prefix, so a demo's caption is never mistaken for a real
 * translation.
 */
function mockTranslator(): Translator {
  return {
    provider: 'mock',
    async translate(texts: string[], target: string): Promise<string[]> {
      const tag = target.toUpperCase();
      return texts.map((text) => (text.trim() ? `[${tag}] ${text}` : text));
    },
  };
}

/**
 * The translator. There is no key to check for: the engine is the public
 * endpoint, so a caller that wants translation gets one.
 */
export function createTranslator(config: TranslatorConfig, fetchImpl: typeof fetch = fetch): Translator {
  // Mock mode answers locally — unless an endpoint was named explicitly, which
  // is how a stand-in (a test's fake DeepL, the smoke rig, a proxy) is used.
  if (config.mock && !config.endpoint) return mockTranslator();
  const options: EngineOptions = { config, fetchImpl };
  const pace = config.paceMs ?? DEFAULT_PACE_MS;

  return {
    provider: 'deepl',
    async translate(texts: string[], target: string, source?: string): Promise<string[]> {
      // Blank cues are structural (a pause on screen); the engine is sent a
      // space so the lists stay aligned, and the original text is kept back.
      const payload = texts.map((text) => (text.trim() ? text : ' '));
      const out = [...texts];
      const chunks = planChunks(payload);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] as { start: number; end: number };
        const slice = payload.slice(chunk.start, chunk.end);
        const translated = await requestChunk(options, slice, target, source);
        for (let inner = 0; inner < slice.length; inner += 1) {
          const original = texts[chunk.start + inner] ?? '';
          out[chunk.start + inner] = original.trim() ? translated[inner] ?? '' : original;
        }
        // This endpoint is not ours; a subtitle file that needs ten requests
        // should not arrive as ten requests in one second.
        if (index < chunks.length - 1 && pace > 0) await sleep(pace);
      }
      return out;
    },
  };
}

export { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS };
