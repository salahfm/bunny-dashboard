/**
 * Subtitles: what a stream offers, read as text so it can be carried to Bunny.
 *
 * Two jobs live here. The first is turning whatever a host hands out — a WebVTT
 * file, an SRT file, or a WebVTT playlist of chunks — into one clean WebVTT
 * document, which is the only thing Bunny's caption endpoint accepts. The second
 * is language bookkeeping: a master playlist says `LANGUAGE=ar` or
 * `NAME="English"`, a host may say `en-US`, and Bunny wants a short ISO 639-1
 * code, so everything is normalised to one shape.
 *
 * Nothing here talks to the network or to Bunny; it is pure text in, text out,
 * which is what makes it testable on its own.
 */

/** One subtitle cue: its (already normalised) timing line and its text. */
export interface SubtitleCue {
  /** A WebVTT timing line, e.g. `00:00:01.000 --> 00:00:04.000`. */
  timing: string;
  /** The cue text, newlines preserved, inline markup left alone. */
  text: string;
}

export interface SubtitleFile {
  cues: SubtitleCue[];
  /** What the source looked like, for the job's report. */
  format: 'vtt' | 'srt';
}

/** `MM:SS.mmm` / `HH:MM:SS,mmm` / `HH:MM:SS.mmm` → a padded WebVTT timestamp. */
function vttTime(raw: string): string | undefined {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!match) return undefined;
  const hours = String(Number(match[1] ?? 0)).padStart(2, '0');
  const minutes = String(Number(match[2])).padStart(2, '0');
  const seconds = match[3] as string;
  const millis = (match[4] ?? '0').padEnd(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

/**
 * A cue's timing line, rewritten as WebVTT. Cue settings (the `align:start`
 * tail a player reads) are kept; only the timestamps are normalised, so a
 * subtitle never drifts from the video it belongs to.
 */
function normalizeTiming(line: string): string | undefined {
  const parts = line.split('-->');
  if (parts.length !== 2) return undefined;
  const start = vttTime(parts[0] ?? '');
  const tail = (parts[1] ?? '').trim().match(/^(\S+)(?:\s+(.*))?$/);
  const end = tail ? vttTime(tail[1] ?? '') : undefined;
  if (!start || !end) return undefined;
  const settings = tail?.[2]?.trim();
  return `${start} --> ${end}${settings ? ` ${settings}` : ''}`;
}

const HEADER_LINES = /^(WEBVTT|NOTE|STYLE|REGION|X-TIMESTAMP-MAP)/i;

/**
 * Reads SRT or WebVTT into cues.
 *
 * Both formats are cue blocks separated by a blank line, and both are found in
 * the wild with either timestamp separator, so one parser handles both and the
 * `format` it reports is only a label for the job's report.
 */
export function parseSubtitle(text: string): SubtitleFile {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const looksVtt = /^WEBVTT/i.test(normalized.trimStart());
  const cues: SubtitleCue[] = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    // Drop the header block (WEBVTT, NOTE, STYLE, …) and any leading junk.
    let index = 0;
    while (index < lines.length && (lines[index] === '' || HEADER_LINES.test(lines[index] ?? ''))) index += 1;
    // SRT numbers its cues; the number is not part of the cue.
    if (index < lines.length && /^\d+$/.test((lines[index] ?? '').trim())) index += 1;
    const timingLine = (lines[index] ?? '').trim();
    if (!timingLine.includes('-->')) continue;
    const timing = normalizeTiming(timingLine);
    if (!timing) continue;
    const body = lines.slice(index + 1).join('\n').trim();
    cues.push({ timing, text: body });
  }

  return { cues, format: looksVtt ? 'vtt' : 'srt' };
}

/** The cues as one WebVTT document — what Bunny's caption endpoint takes. */
export function toWebVtt(cues: SubtitleCue[], header?: string): string {
  const out = ['WEBVTT', ...(header ? [header] : []), ''];
  for (const cue of cues) {
    out.push(cue.timing, cue.text, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Only the cue text, which is what a translator should see. */
export function cueTexts(cues: SubtitleCue[]): string[] {
  return cues.map((cue) => cue.text);
}

/** Rebuilds the cues with translated text, keeping every original timestamp. */
export function withTranslatedText(cues: SubtitleCue[], translated: string[]): SubtitleCue[] {
  return cues.map((cue, index) => ({ timing: cue.timing, text: translated[index]?.trim() || cue.text }));
}

/** `HH:MM:SS.mmm` (or `MM:SS.mmm`) → seconds. */
function timeToSeconds(time: string): number {
  const match = /^(?:\d{1,3}:)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(time.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? '0'}`);
}

function secondsToTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

/**
 * The offset an HLS subtitle segment declares.
 *
 * A subtitle playlist's chunks are WebVTT, but their timestamps are *local to
 * the segment*: `X-TIMESTAMP-MAP=MPEGTS:<pts>,LOCAL:00:00:00.000` says which
 * moment of the video that local zero is. Ignoring it stacks every chunk at the
 * start of the film, so it is turned into a shift in seconds here.
 */
export function parseTimestampOffset(text: string): number {
  const match = /X-TIMESTAMP-MAP\s*=\s*([^\r\n]*)/i.exec(text);
  if (!match) return 0;
  const pts = /MPEGTS\s*:\s*(\d+)/i.exec(match[1] ?? '');
  if (!pts) return 0;
  const seconds = Number(pts[1]) / 90_000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Every cue moved later by `seconds`, timings rebuilt in WebVTT form. */
export function shiftCues(cues: SubtitleCue[], seconds: number): SubtitleCue[] {
  if (!Number.isFinite(seconds) || seconds <= 0) return cues;
  return cues.map((cue) => {
    const [start, tail] = cue.timing.split('-->');
    const endMatch = (tail ?? '').trim().match(/^(\S+)(?:\s+(.*))?$/);
    if (!start || !endMatch) return cue;
    const settings = endMatch[2]?.trim();
    const shifted = `${secondsToTime(timeToSeconds(start) + seconds)} --> ${secondsToTime(timeToSeconds(endMatch[1] ?? '') + seconds)}${settings ? ` ${settings}` : ''}`;
    return { timing: shifted, text: cue.text };
  });
}

/** Rough sniff for a subtitle file, used when a URL carries no useful name. */
export function isSubtitleText(text: string): boolean {
  const head = String(text ?? '').slice(0, 512).trimStart();
  return /^WEBVTT/i.test(head) || /^\d+\s*\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(head) || /\d{2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head);
}

/** A URL that names itself a subtitle, even before it is fetched. */
export function isSubtitleUrl(url: string): boolean {
  return /\.(vtt|srt|ass|ssa|sub)(\?|#|$)/i.test(url);
}

/** ISO 639-2/B and the handful of names a host may send instead of a code. */
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en',
  ara: 'ar',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  por: 'pt',
  ita: 'it',
  rus: 'ru',
  tur: 'tr',
  hin: 'hi',
  urd: 'ur',
  per: 'fa',
  fas: 'fa',
  heb: 'he',
  zho: 'zh',
  chi: 'zh',
  jpn: 'ja',
  kor: 'ko',
  nld: 'nl',
  dut: 'nl',
  pol: 'pl',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  ces: 'cs',
  cze: 'cs',
  ell: 'el',
  gre: 'el',
  hun: 'hu',
  ron: 'ro',
  rum: 'ro',
  ukr: 'uk',
  vie: 'vi',
  tha: 'th',
  ind: 'id',
  msa: 'ms',
  fil: 'tl',
  tgl: 'tl',
};

/** Name → code, for hosts that label a track "English" and leave LANGUAGE off. */
const NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  arabic: 'ar',
  'العربية': 'ar',
  'عربي': 'ar',
  french: 'fr',
  'français': 'fr',
  spanish: 'es',
  'español': 'es',
  german: 'de',
  'deutsch': 'de',
  portuguese: 'pt',
  italian: 'it',
  'italiano': 'it',
  russian: 'ru',
  turkish: 'tr',
  hindi: 'hi',
  urdu: 'ur',
  persian: 'fa',
  farsi: 'fa',
  hebrew: 'he',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  dutch: 'nl',
  polish: 'pl',
  swedish: 'sv',
  danish: 'da',
  norwegian: 'no',
  finnish: 'fi',
  czech: 'cs',
  greek: 'el',
  hungarian: 'hu',
  romanian: 'ro',
  ukrainian: 'uk',
  vietnamese: 'vi',
  thai: 'th',
  indonesian: 'id',
  malay: 'ms',
  tagalog: 'tl',
};

/**
 * The ISO 639-1 code for a track, from whatever the manifest and host knew.
 *
 * `en-US`, `ENG`, `English` and a bare `en` all answer `en`. Anything that
 * cannot be understood returns undefined rather than a guess, because a caption
 * filed under the wrong language is worse than one that says it is unknown.
 */
export function normalizeLanguage(language?: string, name?: string): string | undefined {
  const raw = (language ?? '').trim().toLowerCase();
  if (raw) {
    const short = raw.split(/[-_]/)[0] ?? raw;
    if (/^[a-z]{2}$/.test(short)) return short;
    if (LANGUAGE_ALIASES[short]) return LANGUAGE_ALIASES[short];
    if (/^[a-z]{3}$/.test(short)) return LANGUAGE_ALIASES[short];
  }
  const label = (name ?? '').trim().toLowerCase().replace(/[._-]+$/, '');
  if (label) {
    if (NAME_TO_CODE[label]) return NAME_TO_CODE[label];
    const first = label.split(/[\s(]/)[0] ?? '';
    if (NAME_TO_CODE[first]) return NAME_TO_CODE[first];
  }
  return undefined;
}

/** A tidy display label for a code, used when a host supplied none. */
export function languageLabel(code: string): string {
  const known: Record<string, string> = {
    ar: 'العربية',
    en: 'English',
    fr: 'Français',
    es: 'Español',
    de: 'Deutsch',
    pt: 'Português',
    it: 'Italiano',
    ru: 'Русский',
    tr: 'Türkçe',
    hi: 'हिन्दी',
    ur: 'اردو',
    fa: 'فارسی',
    he: 'עברית',
    zh: '中文',
    ja: '日本語',
    ko: '한국어',
    nl: 'Nederlands',
    pl: 'Polski',
    sv: 'Svenska',
    da: 'Dansk',
    no: 'Norsk',
    fi: 'Suomi',
    cs: 'Čeština',
    el: 'Ελληνικά',
    hu: 'Magyar',
    ro: 'Română',
    uk: 'Українська',
    vi: 'Tiếng Việt',
    th: 'ไทย',
    id: 'Bahasa Indonesia',
    ms: 'Bahasa Melayu',
    tl: 'Tagalog',
  };
  return known[code] ?? code.toUpperCase();
}
