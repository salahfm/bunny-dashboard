/**
 * Subtitle backfill: put the target languages onto titles that are already
 * published without them.
 *
 * Why this exists: a title is published once. If it arrived with English
 * subtitles and no Arabic — because the translation was switched off, because
 * DeepL was rate-limiting this machine, or because it was published before the
 * subtitle pipeline existed at all — then re-queueing it to get the Arabic means
 * downloading the whole title again and publishing it a second time. This does
 * neither. The video is already in Bunny, so only the *subtitle half* of the
 * pipeline is re-run: find source-language cue text, translate it, attach the
 * captions, and record the new tracks on the catalogue entry.
 *
 * A title can need more than one language (`SUBTITLE_TARGET_LANG=ar,fr,es`), and
 * the source cue text is read once no matter how many are missing: one download,
 * one translation per language, one caption each. A language that fails leaves
 * the others alone and is reported on its own.
 *
 * Where the cue text comes from, in order:
 *
 *   1. **The subtitle URL the catalogue recorded.** When a track was attached,
 *      the URL it was scraped from was kept on the entry — one request, and it is
 *      the exact file that was used the first time.
 *   2. **The source's master playlist, re-read.** For a title with no recorded
 *      subtitle URL, the master playlist the catalogue kept for its source is
 *      fetched again and its `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions are used.
 *      The manifest is the one place a stream honestly declares its subtitles, so
 *      it is asked rather than guessed at.
 *
 * English is preferred as the pivot in both cases: it is the language the targets
 * were designed to be translated from. Everything else about the translation is
 * the normal engine — text only, timings untouched, and a refusal is reported
 * against the title rather than thrown away.
 */
import type { BunnyClient } from './bunny';
import type { Catalog, CatalogEntry } from './catalog';
import type { AppConfig } from './config';
import { parseSubtitleRenditions } from './hls';
import { fetchScrapeText } from './providers';
import { cueTexts, languageLabel, normalizeLanguage, toWebVtt, withTranslatedText, type SubtitleCue } from './subtitles';
import { fetchSubtitleCues } from './stream';
import type { SubtitleTrack } from './store';
import { createTranslator } from './translate';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BackfillDeps {
  config: AppConfig;
  catalog: Catalog;
  /** The Bunny client for the account that published an entry; undefined when that account is gone. */
  client: (entry: CatalogEntry) => BunnyClient | undefined;
  log?: (message: string) => void;
}

/** One title a run would work on, and what it would work from. */
export interface BackfillCandidate {
  key: string;
  title: string;
  season?: number;
  episode?: number;
  videoId?: string;
  /** The languages this title is still missing — what one press would attach. */
  missing: string[];
  /** The URL the cue text would be read from, when it can be worked out. */
  from?: string;
  /** Set when the title cannot be tried at all, with the reason. */
  note?: string;
}

export interface BackfillOutcome {
  key: string;
  title: string;
  status: 'translated' | 'skipped' | 'failed';
  note?: string;
  /** The languages that were attached; a run fills in every missing one it can. */
  languages?: string[];
  cues?: number;
  bytes?: number;
}

export interface BackfillPreview {
  /** The configured target languages, in order. */
  targets: string[];
  /** How many published titles are missing at least one of them. */
  total: number;
  candidates: BackfillCandidate[];
}

export interface BackfillReport {
  targets: string[];
  /** How many titles wanted a language when the run started. */
  candidates: number;
  attempted: number;
  translated: number;
  failed: number;
  skipped: number;
  /** Still missing afterwards among the titles this run selected. */
  remaining: number;
  results: BackfillOutcome[];
}

/** True when this entry already holds an uploaded caption in `language`. */
export function hasSubtitle(entry: CatalogEntry, language: string): boolean {
  return (entry.subtitles ?? []).some((track) => track.srclang === language && track.uploaded);
}

/** The configured languages this entry has no uploaded caption for, in order. */
export function missingTargets(entry: CatalogEntry, targets: string[]): string[] {
  return targets.filter((language) => !hasSubtitle(entry, language));
}

/**
 * The track a translation should start from.
 *
 * Only tracks whose text URL is known can be used, and English wins: it is what
 * the target languages were designed to be translated from.
 */
export function pivotTrack(entry: CatalogEntry): SubtitleTrack | undefined {
  const usable = (entry.subtitles ?? []).filter((track) => track.url);
  return usable.find((track) => track.srclang === 'en') ?? usable[0];
}

/** One language's track in a list, replacing the record of an earlier attempt. */
function withTrack(tracks: SubtitleTrack[], track: SubtitleTrack): SubtitleTrack[] {
  return [...tracks.filter((item) => item.srclang !== track.srclang), track];
}

/** The master playlist the catalogue recorded for this title's source. */
function recordedSource(entry: CatalogEntry): { url: string; headers: Record<string, string> } | undefined {
  const base = entry.sourceHeaders ?? {};
  if (entry.sourceUrl) return { url: entry.sourceUrl, headers: base };
  const candidates = entry.sources ?? [];
  const chosen = candidates.find((source) => source.chosen) ?? candidates[0];
  if (chosen?.url) return { url: chosen.url, headers: { ...base, ...(chosen.headers ?? {}) } };
  return undefined;
}

/** What one title's cue text turned out to be, or why it could not be read. */
type SourceText =
  | { ok: true; srclang: string; label: string; url: string; cues: SubtitleCue[] }
  | { ok: false; note: string };

/**
 * The caption an *automatic* repair can read text from.
 *
 * [pivotTrack] only needs a URL: the manual action is happy to try a track whose
 * fetch once failed, because a person pressed the button and the preview said
 * where the text would come from. The automatic pass is stricter — it re-runs
 * only the translation half, so it wants a track that was **uploaded**, which is
 * proof the cue text really was read. A title whose source was never readable is
 * left to the Library, where the preview explains what would have to change.
 */
export function readablePivot(entry: CatalogEntry): SubtitleTrack | undefined {
  const usable = (entry.subtitles ?? []).filter((track) => track.url && track.uploaded);
  return usable.find((track) => track.srclang === 'en') ?? usable[0];
}

/**
 * The languages a finished publish left missing that can be filled in
 * automatically, in the configured order. Empty means "nothing to do".
 */
export function repairable(entry: CatalogEntry, targets: string[]): string[] {
  const missing = missingTargets(entry, targets);
  if (!missing.length) return [];
  if (!entry.videoId || !entry.accountId) return [];
  return readablePivot(entry) ? missing : [];
}

export class SubtitleBackfill {
  private deps: BackfillDeps;

  constructor(deps: BackfillDeps) {
    this.deps = deps;
  }

  /** What a run would do, without touching the network. */
  preview(): BackfillPreview {
    const targets = this.deps.config.subtitleTargetLanguages;
    const candidates = this.deps.catalog
      .all()
      .filter((entry) => missingTargets(entry, targets).length > 0)
      .map((entry) => this.candidate(entry, targets));
    return { targets, total: candidates.length, candidates };
  }

  /** One title as the preview lists it — no client is built, nothing is fetched. */
  private candidate(entry: CatalogEntry, targets: string[]): BackfillCandidate {
    const shape: BackfillCandidate = {
      key: entry.key,
      title: entry.title,
      missing: missingTargets(entry, targets),
      ...(entry.season !== undefined ? { season: entry.season } : {}),
      ...(entry.episode !== undefined ? { episode: entry.episode } : {}),
      ...(entry.videoId ? { videoId: entry.videoId } : {}),
    };
    if (!entry.videoId) return { ...shape, note: 'no Bunny video id was recorded' };
    if (!entry.accountId) return { ...shape, note: 'no account was recorded for it' };
    const pivot = pivotTrack(entry);
    if (pivot?.url) return { ...shape, from: pivot.url };
    const source = recordedSource(entry);
    if (!source) return { ...shape, note: 'the catalogue kept no source to read subtitle tracks from' };
    return { ...shape, from: source.url };
  }

  /**
   * Fill in the missing languages, a batch at a time.
   *
   * `keys` narrows the run to what the operator selected; `limit` bounds how much
   * one request does, because every title inside it is a real fetch, at least one
   * real translation and a real upload. A batch that was cut short is simply
   * still missing next time.
   *
   * Each selected title goes through [one] exactly once, and [one] reads that
   * title's source text once before looping its missing languages — so a batch
   * of N titles downloads N source tracks, never N × languages, and a title that
   * is already complete is not a candidate at all.
   */
  async run(options: { keys?: string[]; limit?: number } = {}): Promise<BackfillReport> {
    const targets = this.deps.config.subtitleTargetLanguages;
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit ?? 25)) || 25));
    const wanted = this.deps.catalog.all().filter((entry) => missingTargets(entry, targets).length > 0);
    const selected = options.keys?.length ? wanted.filter((entry) => options.keys?.includes(entry.key)) : wanted;
    const batch = selected.slice(0, limit);

    const results: BackfillOutcome[] = [];
    for (const entry of batch) {
      const outcome = await this.one(entry, targets).catch((error): BackfillOutcome => ({
        key: entry.key,
        title: entry.title,
        status: 'failed',
        note: describeError(error),
      }));
      results.push(outcome);
    }

    const count = (status: BackfillOutcome['status']) => results.filter((result) => result.status === status).length;
    const stillMissing = (entry: CatalogEntry) => missingTargets(this.deps.catalog.get(entry.key) ?? entry, targets).length > 0;
    return {
      targets,
      candidates: selected.length,
      attempted: batch.length,
      translated: count('translated'),
      failed: count('failed'),
      skipped: count('skipped'),
      remaining: selected.filter(stillMissing).length,
      results,
    };
  }

  /** One title: read its cue text once, then translate and attach every missing language. */
  private async one(entry: CatalogEntry, targets: string[]): Promise<BackfillOutcome> {
    const base = { key: entry.key, title: entry.title };
    const missing = missingTargets(entry, targets);
    if (!missing.length) {
      return { ...base, status: 'skipped', note: `every configured language is already attached (${targets.join(', ')})` };
    }
    if (!entry.videoId) return { ...base, status: 'skipped', note: 'no Bunny video id was recorded' };
    if (!this.deps.config.subtitleTranslate) {
      return { ...base, status: 'skipped', note: 'translation is switched off (SUBTITLE_TRANSLATOR=off)' };
    }
    const client = this.deps.client(entry);
    if (!client) {
      return { ...base, status: 'skipped', note: `the account that published it is gone (${entry.accountId ?? 'none'})` };
    }

    const source = await this.sourceText(entry, targets);
    if (!source.ok) return { ...base, status: 'failed', note: source.note };

    const translator = createTranslator({
      timeoutMs: this.deps.config.networkTimeoutMs,
      retries: this.deps.config.networkRetries,
      mock: this.deps.config.mock,
      ...(this.deps.config.subtitleTranslateEndpoint ? { endpoint: this.deps.config.subtitleTranslateEndpoint } : {}),
    });

    // The cue text is the same for every language, so it was read once; only the
    // translation and the caption are per language.
    const text = cueTexts(source.cues);
    const languages: string[] = [];
    const failures: string[] = [];
    let bytes = 0;
    for (const target of missing) {
      try {
        const translated = await translator.translate(text, target, source.srclang);
        const label = `${languageLabel(target)} (translated)`;
        const body = toWebVtt(withTranslatedText(source.cues, translated), `translated from ${languageLabel(source.srclang)} (${translator.provider})`);
        await client.addCaption(entry.videoId, target, label, body);
        const track: SubtitleTrack = {
          srclang: target,
          label,
          uploaded: true,
          translated: true,
          translatedFrom: source.srclang,
          cues: source.cues.length,
          bytes: Buffer.byteLength(body),
        };
        // Only the languages that landed are recorded, and each replaces an
        // earlier attempt at itself; the rest of the record is untouched.
        const current = this.deps.catalog.get(entry.key)?.subtitles ?? entry.subtitles ?? [];
        this.deps.catalog.setSubtitles(entry.key, withTrack(current, track));
        languages.push(target);
        bytes += track.bytes ?? 0;
        this.deps.log?.(`[backfill] ${entry.key}: attached ${target} from ${source.cues.length} ${source.srclang} cue(s)`);
      } catch (error) {
        failures.push(`${target}: ${describeError(error)}`);
      }
    }

    if (!languages.length) return { ...base, status: 'failed', note: failures.join('; ') };
    if (failures.length) {
      return {
        ...base,
        status: 'translated',
        languages,
        cues: source.cues.length,
        bytes,
        note: `attached ${languages.join(', ')} — not ${failures.join('; ')}`,
      };
    }
    return { ...base, status: 'translated', languages, cues: source.cues.length, bytes };
  }

  /**
   * The cue text to translate, whatever it takes.
   *
   * Problems are collected rather than thrown: "the recorded subtitle file is
   * gone" and "the source declares no subtitle tracks" are both worth reporting,
   * and the second one is only knowable after trying the first.
   */
  private async sourceText(entry: CatalogEntry, targets: string[]): Promise<SourceText> {
    const headers = entry.sourceHeaders ?? {};
    const problems: string[] = [];

    const pivot = pivotTrack(entry);
    if (pivot?.url) {
      const cues = await fetchSubtitleCues(pivot.url, headers).catch((error) => {
        problems.push(`the recorded ${pivot.srclang} subtitle could not be read: ${describeError(error)}`);
        return undefined;
      });
      if (cues?.length) {
        return { ok: true, srclang: pivot.srclang, label: pivot.label || languageLabel(pivot.srclang), url: pivot.url, cues };
      }
      if (cues) problems.push(`the recorded ${pivot.srclang} subtitle held no cues`);
    }

    const source = recordedSource(entry);
    if (!source) {
      return { ok: false, note: problems.length ? problems.join('; ') : 'the catalogue kept no source to read subtitle tracks from' };
    }
    const master = await fetchScrapeText(source.url, source.headers).catch((error) => {
      problems.push(`the source could not be re-read: ${describeError(error)}`);
      return undefined;
    });
    if (!master) return { ok: false, note: problems.join('; ') };

    const renditions = parseSubtitleRenditions(master, source.url);
    if (!renditions.length) {
      problems.push('the source declares no subtitle tracks');
      return { ok: false, note: problems.join('; ') };
    }

    // English first; a target language is never a source — it is the thing being
    // filled in.
    const ranked = [...renditions].sort((a, b) => rank(renditionLanguage(a)) - rank(renditionLanguage(b)));
    for (const rendition of ranked) {
      const srclang = renditionLanguage(rendition);
      if (!srclang || targets.includes(srclang)) continue;
      const cues = await fetchSubtitleCues(rendition.url, headers).catch((error) => {
        problems.push(`the ${srclang} subtitle could not be read: ${describeError(error)}`);
        return undefined;
      });
      if (cues?.length) {
        return { ok: true, srclang, label: rendition.name || languageLabel(srclang), url: rendition.url, cues };
      }
      if (cues) problems.push(`the ${srclang} subtitle held no cues`);
    }
    if (!problems.length) problems.push('no usable subtitle track was found');
    return { ok: false, note: problems.join('; ') };
  }
}

export interface AutoRepairDeps {
  config: AppConfig;
  catalog: Catalog;
  backfill: SubtitleBackfill;
  /** Whether the operator wants this — the Library setting; absent means yes. */
  enabled?: () => boolean;
  log?: (message: string) => void;
  /** Wait before a failed repair is tried again; doubles per attempt. */
  retryDelayMs?: number;
  /** Automatic attempts per publish; 1 means "try once, then leave it". */
  maxAttempts?: number;
}

/** Automatic attempts per publish before the title is left to the manual action. */
const AUTO_REPAIR_ATTEMPTS = 3;
/** First retry delay. The usual failure is a rate limit, which needs time, not speed. */
const AUTO_REPAIR_RETRY_MS = 60_000;

/** One title waiting its turn, and how many times it has been tried. */
interface QueuedRepair {
  key: string;
  attempts: number;
}

/**
 * Fills in what a publish left missing, without being asked.
 *
 * The usual reason a language is absent after a publish is not a mistake in the
 * data — it is a refused translation (DeepL rate-limiting this machine, a
 * transient refusal, a caption upload Bunny would not take). The pipeline itself
 * proves it when it happens: the source track uploaded, only the target language
 * did not. This listens for exactly that state and queues the same work the
 * Library's button does, so a rate-limited title heals itself instead of sitting
 * in the Library until someone notices.
 *
 * One title at a time, in memory: a repair is a real fetch, a real translation
 * and a real upload, and a burst of publishes must not turn into a burst of
 * DeepL requests. A failed attempt is tried again after a pause (doubling), and
 * after the budget the title is left to the Library, which reports why.
 */
export class SubtitleAutoRepair {
  private deps: AutoRepairDeps;
  private queue: QueuedRepair[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Keys queued, waiting on a retry, or in flight — never two of them at once. */
  private active = new Set<string>();
  private draining: Promise<void> | undefined;
  private stopped = false;
  private logLine: (message: string) => void;

  constructor(deps: AutoRepairDeps) {
    this.deps = deps;
    this.logLine = deps.log ?? ((message) => console.log(message));
  }

  /**
   * Called with the catalogue entry a finished job wrote. Queues a fill-in when
   * this publish left something the repair can take from here, and says so;
   * returns false when there is nothing to do (or the title is already queued).
   */
  consider(entry: CatalogEntry): boolean {
    if (this.stopped) return false;
    if (!(this.deps.enabled?.() ?? true)) return false;
    // With translation off nothing can be created, and queueing it would only
    // log a skip per publish.
    if (!this.deps.config.subtitleTranslate) return false;
    const missing = repairable(entry, this.deps.config.subtitleTargetLanguages);
    if (!missing.length) return false;
    if (this.active.has(entry.key)) return false;
    this.active.add(entry.key);
    this.queue.push({ key: entry.key, attempts: 0 });
    this.logLine(`[repair] ${entry.key} published without ${missing.join(', ')} — filling it in automatically`);
    void this.drain();
    return true;
  }

  /** Runs the queue to completion, one title at a time. */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const item = this.queue.shift();
        if (!item) break;
        await this.attempt(item);
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async attempt(item: QueuedRepair): Promise<void> {
    const budget = Math.max(1, Math.floor(this.deps.maxAttempts ?? AUTO_REPAIR_ATTEMPTS));
    item.attempts += 1;

    let outcome: BackfillOutcome | undefined;
    let failure: string | undefined;
    try {
      const report = await this.deps.backfill.run({ keys: [item.key], limit: 1 });
      outcome = report.results[0];
    } catch (error) {
      failure = describeError(error);
    }

    // A skip is terminal: every configured language is attached, or the title
    // has no video, no account, or translation is off. None of those improve by
    // waiting, so the queue says what happened and moves on.
    if (outcome?.status === 'skipped') {
      this.active.delete(item.key);
      this.logLine(`[repair] ${item.key}: nothing to do — ${outcome.note ?? 'skipped'}`);
      return;
    }
    // No note means every missing language landed.
    if (outcome?.status === 'translated' && !outcome.note) {
      this.active.delete(item.key);
      this.logLine(`[repair] ${item.key}: attached ${(outcome.languages ?? []).join(', ')} from ${outcome.cues ?? 0} cue(s)`);
      return;
    }

    const reason = outcome?.note ?? failure ?? 'the fill-in did not report an outcome';
    if (item.attempts < budget) {
      const waitMs = this.retryDelay(item.attempts);
      this.logLine(`[repair] ${item.key}: ${reason} — trying again in ${Math.round(waitMs / 1000)} s`);
      this.schedule(item, waitMs);
      return;
    }
    this.active.delete(item.key);
    this.logLine(`[repair] ${item.key}: gave up after ${item.attempts} attempt(s) — ${reason}`);
  }

  /** The pause before the next attempt; doubles, because a rate limit needs time. */
  private retryDelay(attempts: number): number {
    const base = Math.max(0, this.deps.retryDelayMs ?? AUTO_REPAIR_RETRY_MS);
    return base * 2 ** Math.max(0, attempts - 1);
  }

  private schedule(item: QueuedRepair, waitMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(item.key);
      if (this.stopped) return;
      this.queue.push(item);
      void this.drain();
    }, waitMs);
    timer.unref?.();
    this.timers.set(item.key, timer);
  }

  /** Resolves once nothing is queued, in flight or waiting on a retry. */
  async idle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.draining || this.queue.length > 0 || this.timers.size > 0) {
      if (Date.now() > deadline) throw new Error(`the repair queue was still busy after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /**
   * Resolves once this one title is not queued, in flight or waiting on a
   * retry.
   *
   * The archive waits on this before it reads a video: deleting from Bunny while
   * a caption upload is still in flight would throw that translation away. A
   * title that was never queued resolves at once, so the archive of an ordinary
   * publish is not delayed at all.
   */
  async settled(key: string, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.has(key)) {
      if (Date.now() > deadline) throw new Error(`the subtitle repair for ${key} was still busy after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Stops the queue and forgets pending retries. Nothing is persisted: a
   * restart re-learns from publishes, and the Library still lists what is left.
   */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
  }
}

/** The language a manifest rendition declares, normalised to an ISO 639-1 code. */
function renditionLanguage(rendition: { language?: string; name?: string }): string | undefined {
  return normalizeLanguage(rendition.language, rendition.name);
}

/** English sorts first; everything else keeps the manifest's order. */
function rank(srclang: string | undefined): number {
  return srclang === 'en' ? 0 : 1;
}
