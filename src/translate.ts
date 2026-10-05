/**
 * Text translation for subtitles — deliberately text-only.
 *
 * bunny.net's own translate runs Whisper over the **audio** first; that is
 * speech recognition, not translation, and it is not what this does. When a
 * title arrives with English subtitles and no Arabic, the English cue *text* is
 * translated here and the result is uploaded to Bunny as a normal Arabic
 * caption, with the original timings untouched — nothing listens to the audio.
 *
 * Two engines are wired, because "best Arabic" depends on the setup:
 *
 *   - `openai` speaks the OpenAI chat-completions shape, so it works against
 *     OpenAI, OpenRouter, Groq, Together, a local Ollama/LM Studio, or anything
 *     else with a compatible endpoint. A model translates with the whole cue
 *     list in front of it, which is what keeps names, register and pronoun
 *     choices consistent across a film — generally the best Arabic for
 *     subtitles.
 *   - `deepl` is a dedicated translation engine with strong Arabic and a free
 *     tier, for when no model endpoint is available.
 *
 * Only cue text is ever sent. Timings, cue count and order stay exactly as the
 * source had them, so the Arabic track stays in sync by construction.
 */
import { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS, fetchWithPolicy, NetworkError } from './net';

export type TranslatorProvider = 'openai' | 'deepl';

export interface TranslatorConfig {
  provider: TranslatorProvider;
  apiKey: string;
  /** Overrides the provider's default endpoint (any OpenAI-compatible base). */
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
  retries: number;
}

export interface Translator {
  readonly provider: TranslatorProvider;
  readonly model: string | undefined;
  /** One translation per input string, in the same order. */
  translate(texts: string[], targetLanguage: string, sourceLanguage?: string): Promise<string[]>;
}

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

/** Cue texts per request: enough context to be idiomatic, small enough to be safe. */
const CHUNK_SIZE = 40;

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic (Modern Standard Arabic)',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  tr: 'Turkish',
  ru: 'Russian',
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

/**
 * How the model is asked to translate. Written for subtitles specifically: a
 * line has to read naturally on screen at the same moment the original did, so
 * the prompt asks for spoken-register Arabic rather than literal prose, keeps
 * names in a consistent transliteration, and forbids adding or merging cues —
 * the cue count is how the result is matched back to the timings.
 */
function systemPrompt(target: string, source?: string): string {
  return [
    `You are a professional subtitle translator. You translate subtitle cue text${source ? ` from ${languageName(source)}` : ''} into ${languageName(target)}.`,
    'Rules:',
    '- Translate every cue. Never merge, split, drop or add cues.',
    `- Keep the meaning, tone and register; where the original is spoken dialogue, use natural spoken ${languageName(target)} that fits the same on-screen time.`,
    `- For Arabic, use clear Modern Standard Arabic with natural dialogue phrasing; do not romanise, and do not leave English words unless they are proper nouns.`,
    '- Keep proper nouns and character names as they are normally written in the target language, consistently across the whole list.',
    '- Preserve inline markup (<i>…</i>, <b>…</b>) and keep a line break where the original had one.',
    '- Never translate the timing or add commentary.',
    'Reply with JSON only, exactly this shape: {"translations":["…","…"]} — one string per input cue, in the same order.',
  ].join('\n');
}

/** Pulls the JSON payload out of a model reply that may be wrapped in prose or fences. */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const attempts = [trimmed];
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) attempts.push(trimmed.slice(objectStart, objectEnd + 1));
  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(trimmed.slice(arrayStart, arrayEnd + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try the next shape */
    }
  }
  throw new TranslationError('the translation service did not answer with JSON');
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>).translations ?? (value as Record<string, unknown>).items;
    if (Array.isArray(inner) && inner.every((item) => typeof item === 'string')) return inner as string[];
  }
  return undefined;
}

interface EngineOptions {
  config: TranslatorConfig;
  fetchImpl: typeof fetch;
}

async function postJson(options: EngineOptions, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchWithPolicy(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
      {
        what: 'the translation service',
        fetchImpl: options.fetchImpl,
        timeoutMs: options.config.timeoutMs,
        retries: options.config.retries,
        backoffMs: 800,
      },
    );
  } catch (error) {
    if (error instanceof NetworkError) throw new TranslationError(error.message);
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      /* keep the raw slice */
    }
    throw new TranslationError(`the translation service refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return extractJson(text);
}

async function translateWithModel(options: EngineOptions, texts: string[], target: string, source?: string): Promise<string[]> {
  const base = (options.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = options.config.model ?? 'gpt-4o-mini';
  const payload = await postJson(
    options,
    `${base}/chat/completions`,
    { authorization: `Bearer ${options.config.apiKey}` },
    {
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt(target, source) },
        { role: 'user', content: JSON.stringify({ targetLanguage: target, cues: texts }) },
      ],
    },
  );
  const body = payload as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new TranslationError('the model returned no translation');
  const translations = stringArray(extractJson(content));
  if (!translations) throw new TranslationError('the model did not return a list of translations');
  if (translations.length !== texts.length) {
    throw new TranslationError(`the model returned ${translations.length} translations for ${texts.length} cues`);
  }
  return translations;
}

async function translateWithDeepL(options: EngineOptions, texts: string[], target: string, source?: string): Promise<string[]> {
  const key = options.config.apiKey;
  // DeepL splits free and paid accounts by host, and the key itself says which.
  const base = (options.config.baseUrl ?? (/:(fx|free)$/i.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com')).replace(/\/+$/, '');
  // Cue text must arrive verbatim: told nothing, DeepL would "improve" the lines.
  const payload = await postJson(
    options,
    `${base}/v2/translate`,
    { authorization: `DeepL-Auth-Key ${key}` },
    {
      text: texts,
      target_lang: target.toUpperCase(),
      ...(source ? { source_lang: source.toUpperCase() } : {}),
      preserve_formatting: true,
      split_sentences: '1',
    },
  );
  const body = payload as { translations?: Array<{ text?: string }> };
  const translations = (body.translations ?? []).map((entry) => entry.text ?? '');
  if (translations.length !== texts.length) {
    throw new TranslationError(`DeepL returned ${translations.length} translations for ${texts.length} cues`);
  }
  return translations;
}

/** The translator this configuration asks for, or undefined when none is set up. */
export function createTranslator(config: TranslatorConfig | undefined, fetchImpl: typeof fetch = fetch): Translator | undefined {
  if (!config || !config.apiKey.trim()) return undefined;
  const options: EngineOptions = { config, fetchImpl };
  const provider = config.provider;

  return {
    provider,
    model: provider === 'openai' ? config.model ?? 'gpt-4o-mini' : undefined,
    async translate(texts: string[], target: string, source?: string): Promise<string[]> {
      const out: string[] = [];
      for (let index = 0; index < texts.length; index += CHUNK_SIZE) {
        const chunk = texts.slice(index, index + CHUNK_SIZE);
        // Blank cues are structural (a pause on screen); nothing to send.
        const payload = chunk.map((text) => (text.trim() ? text : ' '));
        const translated =
          provider === 'openai'
            ? await translateWithModel(options, payload, target, source)
            : await translateWithDeepL(options, payload, target, source);
        for (let inner = 0; inner < chunk.length; inner += 1) {
          out.push(chunk[inner]?.trim() ? translated[inner] ?? '' : (chunk[inner] ?? ''));
        }
      }
      return out;
    },
  };
}

export { DEFAULT_FETCH_RETRIES, DEFAULT_FETCH_TIMEOUT_MS };
