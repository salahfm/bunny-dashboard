/**
 * Embed-host scrapers, ported from the ogaro backend (`lib/providers/*`) with
 * only the parts this dashboard needs: resolve a TMDB target (or an embed page)
 * into playable media URLs together with the headers the CDN requires.
 *
 * What was deliberately dropped: subtitles, the Arabic-track ordering, and the
 * headless-browser replay ogaro uses for the two hosts that only answer a real
 * browser (vidfast, cinesrc). Those two keep their plain page scan here, which
 * is exactly the fallback ogaro itself runs when no browser is configured.
 */
import { HostGuard, hostOf, isBlockingStatus, looksLikeChallenge } from './hostguard';
import { fetchWithPolicy } from './net';
import { proxyFetcher, type ProxyEndpoint, type ProxyPool } from './proxies';
import type { JobTarget } from './store';

export type StreamType = 'hls' | 'mp4';

export interface ProviderStream {
  label: string;
  quality: string;
  url: string;
  /** Headers the media CDN requires (Referer/Origin/User-Agent). */
  headers: Record<string, string>;
  type: StreamType;
  /** Where this URL came from, for the dashboard's job detail. */
  provider: string;
  providerId: string;
}

export interface ResolveContext {
  tmdbId: string;
  title: string;
  year: string;
  isSeries: boolean;
  season?: number;
  episode?: number;
}

export interface EmbedProvider {
  id: string;
  name: string;
  kind: 'api' | 'html';
  /** Per-host cap; a host that has to be replayed in a browser would need more. */
  timeoutMs?: number;
  resolve(ctx: ResolveContext): Promise<ProviderStream[]>;
}

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export const ENC_DEC_BASE = 'https://enc-dec.app/api';

/** The target as the providers address it (strings, with 1-based season/episode). */
export function contextFor(target: JobTarget): ResolveContext {
  return {
    tmdbId: String(target.tmdbId),
    title: target.title,
    year: target.year ?? '',
    isSeries: target.kind === 'episode',
    ...(target.kind === 'episode' ? { season: target.season ?? 1, episode: target.episode ?? 1 } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export function baseHeaders(referer?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...extra };
  if (referer) {
    headers.Referer = referer.endsWith('/') ? referer : `${referer}/`;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {
      /* a malformed referer is simply not sent */
    }
  }
  return headers;
}

export function streamHeaders(referer?: string, extra: Record<string, string> = {}, mediaUrl?: string): Record<string, string> {
  const headers = baseHeaders(referer, { 'Accept-Language': 'en-US,en;q=0.9', ...extra });
  // One host hands out URLs that only its own player client may open.
  if ((mediaUrl ?? '').toLowerCase().includes('hakunaymatata')) {
    return { 'User-Agent': 'ExoPlayerLib/2.18.1', Accept: '*/*', ...extra };
  }
  return headers;
}

/**
 * `fetch` with a hard timeout and one retry, so a slow or flaky host cannot
 * stall a resolve and a single dropped connection does not lose a whole source.
 * The provider's own cap still bounds the total: retries here never extend it.
 *
 * This is the raw transport (candidate probes and media downloads use it too),
 * so it is deliberately not throttled per host — see [scrapeSend]. It is also the
 * reason the proxy pool cannot leak into the download path: the pool is only ever
 * handed in by the scrape layer, as `via`, and a media request passes nothing.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 9000,
  via?: typeof fetch,
): Promise<Response> {
  return fetchWithPolicy(url, init, {
    timeoutMs,
    retries: 1,
    backoffMs: 400,
    what: 'the host',
    ...(via ? { fetchImpl: via } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Outbound policy for the scraping hosts                              */
/* ------------------------------------------------------------------ */

/** Raised when a host is in cooldown and the request was not even attempted. */
export class HostBlockedError extends Error {
  host: string;

  constructor(message: string, host: string) {
    super(message);
    this.name = 'HostBlockedError';
    this.host = host;
  }
}

let egressMap: Record<string, string> = {};
let hostGuard: HostGuard | undefined;
let proxyPool: ProxyPool | undefined;

/**
 * Wires the shared guard, the host → base rewrite map and the proxy pool into the
 * scraper.
 *
 * The pool is optional and only the scrape layer ever sees it: with no pool every
 * request goes straight out, which is what this dashboard did before one existed.
 */
export function configureScraper(options: {
  egress?: Record<string, string>;
  guard?: HostGuard;
  proxies?: ProxyPool;
}): void {
  if (options.egress) egressMap = options.egress;
  if (options.guard) hostGuard = options.guard;
  if (options.proxies) proxyPool = options.proxies;
}

/** The guard in use, so the dashboard can show which hosts are cooling down. */
export function scraperGuard(): HostGuard | undefined {
  return hostGuard;
}

/** The pool in use, so the dashboard can show which exits are alive. */
export function scraperProxies(): ProxyPool | undefined {
  return proxyPool;
}

/**
 * Where a request for `url` actually goes.
 *
 * With a host in `SCRAPER_EGRESS` the request is re-aimed at that base instead —
 * the intended use is a bunny.net pull zone whose origin is the host, so the
 * request leaves from Bunny's edge rather than this machine. `origin` stays the
 * host the operator is really asking, which is what cooldowns and reports name.
 */
export function egressFor(url: string): { request: string; origin: string; via?: string } {
  const origin = hostOf(url);
  const base = egressMap[origin];
  if (!base) return { request: url, origin };
  try {
    const rewritten = new URL(base);
    const original = new URL(url);
    rewritten.pathname = original.pathname;
    rewritten.search = original.search;
    return { request: rewritten.toString(), origin, via: rewritten.host.toLowerCase() };
  } catch {
    return { request: url, origin };
  }
}

/**
 * How many exits one scrape request may try before the host itself is blamed.
 *
 * Three is enough to step over a set whose plan has run out of bandwidth and a
 * single exit the host happens to dislike, without turning one slow host into a
 * long wait: every attempt after the first one costs a round trip through a
 * different address.
 */
export const SCRAPE_EXITS = 3;

/** How many exits this request may try (one when there is no pool to draw on). */
function scrapeTries(): number {
  const ready = proxyPool?.ready() ?? 0;
  return Math.max(1, Math.min(SCRAPE_EXITS, ready + 1));
}

/**
 * Puts the exit that answered aside after a refusal, and says whether another one
 * is worth asking.
 *
 * A refusal through a proxy may say nothing about the host at all: the block can
 * be on the exit's address, which is the whole reason the pool exists — so the
 * exit is set aside and a different one is tried before the host is cooled down.
 * With no proxy in play there is nothing to rotate to, and the refusal is the
 * host's, exactly as it was before the pool.
 */
function rotateExit(endpoint: ProxyEndpoint | undefined, reason: string): boolean {
  if (!endpoint) return false;
  proxyPool?.report(endpoint, 'blocked', reason);
  return (proxyPool?.ready() ?? 0) > 0;
}

/**
 * One scrape-layer request: paced and serialised per host, refused early while
 * the host is cooling down, and sent through one exit of the pool.
 */
async function scrapeAttempt(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; proxy?: ProxyEndpoint }> {
  const egress = egressFor(url);
  const cooling = hostGuard?.cooling(egress.origin);
  if (cooling) {
    const left = Math.max(1, Math.ceil((cooling.until - Date.now()) / 1000));
    throw new HostBlockedError(`${egress.origin} is cooling down for another ${left}s (${cooling.reason})`, egress.origin);
  }
  const target = hostOf(egress.request);
  // Which exit answered is reported back through this closure, so a reader that
  // finds a refusal inside the *body* (a bot wall) can rotate away from it too.
  let used: ProxyEndpoint | undefined;
  const via = proxyPool ? proxyFetcher(proxyPool, (endpoint) => (used = endpoint)) : undefined;
  const send = (): Promise<Response> => fetchWithTimeout(egress.request, init, timeoutMs, via);
  const response = hostGuard ? await hostGuard.run(target, send) : await send();
  return { response, proxy: used };
}

/**
 * One scrape request, through as many exits as it takes to stop being refused by
 * a proxy that the *host* has no quarrel with.
 *
 * A 401/403/429/503 arriving through a proxy is not yet a verdict on this
 * machine, so it rotates first and only observes the response — which is what
 * starts a host cooldown — once no other exit is worth trying.
 */
async function scrapeSend(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; proxy?: ProxyEndpoint }> {
  const tries = scrapeTries();
  let answer = await scrapeAttempt(url, init, timeoutMs);
  for (let attempt = 1; attempt < tries; attempt += 1) {
    if (!isBlockingStatus(answer.response.status)) break;
    if (!rotateExit(answer.proxy, `HTTP ${answer.response.status}`)) break;
    answer = await scrapeAttempt(url, init, timeoutMs);
  }
  hostGuard?.observe(egressFor(url).origin, answer.response.status, answer.response.headers);
  return answer;
}

export async function fetchJson<T = unknown>(url: string, referer?: string, timeoutMs = 9000): Promise<T | null> {
  try {
    const { response } = await scrapeSend(
      url,
      { headers: baseHeaders(referer, { Accept: 'application/json, text/plain, */*' }) },
      timeoutMs,
    );
    if (!response.ok) return null;
    const text = await response.text();
    if (!text || text.length < 2 || text.trimStart().startsWith('<')) return null;
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof HostBlockedError) throw error;
    return null;
  }
}

export async function fetchText(url: string, referer?: string, timeoutMs = 10000): Promise<string | null> {
  const tries = scrapeTries();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { response, proxy } = await scrapeSend(
        url,
        { headers: baseHeaders(referer, { Accept: 'text/html,application/json,*/*' }) },
        timeoutMs,
      );
      if (!response.ok) return null;
      const text = await response.text();
      // A 200 that is a bot wall is a refusal too. It is a refusal of the exit
      // that got it before it is one of the host — a page that challenges one
      // address happily serves another — so another exit is asked first, and
      // only a wall at every exit cools this host down.
      if (looksLikeChallenge(text)) {
        const egress = egressFor(url);
        if (attempt < tries && rotateExit(proxy, 'a bot challenge')) continue;
        hostGuard?.penalize(egress.origin, 'a bot challenge');
        throw new HostBlockedError(`${egress.origin} answered a bot challenge instead of the page`, egress.origin);
      }
      return text;
    } catch (error) {
      if (error instanceof HostBlockedError) throw error;
      return null;
    }
  }
}

/**
 * A scrape-side text fetch with explicit headers.
 *
 * Subtitle tracks come from the same hosts, in the same request shape, as the
 * page that declared them — so they go through the same guard, the same egress
 * rewrite and the same bot-wall check. A host that starts refusing subtitles
 * cools down exactly like one that refuses a page. Unlike [fetchText] this
 * throws, because a missing subtitle is worth a note on the job rather than a
 * silent null.
 */
export async function fetchScrapeText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<string> {
  const tries = scrapeTries();
  for (let attempt = 1; ; attempt += 1) {
    const { response, proxy } = await scrapeSend(url, { headers: { ...baseHeaders(headers.Referer), ...headers } }, timeoutMs);
    if (!response.ok) throw new Error(`the subtitle request failed (HTTP ${response.status})`);
    const body = await response.text();
    if (looksLikeChallenge(body)) {
      const egress = egressFor(url);
      if (attempt < tries && rotateExit(proxy, 'a bot challenge')) continue;
      hostGuard?.penalize(egress.origin, 'a bot challenge');
      throw new HostBlockedError(`${egress.origin} answered a bot challenge instead of the file`, egress.origin);
    }
    return body;
  }
}

/** enc-dec.app encryptor, used by hosts that only accept an encrypted id. */
export async function encDecEncrypt(endpoint: string, text: string): Promise<string | null> {
  const data = await fetchJson<{ result?: string; text?: string }>(
    `${ENC_DEC_BASE}/${endpoint}?text=${encodeURIComponent(text)}`,
    undefined,
    9000,
  );
  const value = data?.result ?? data?.text;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const QUALITIES: Array<[RegExp, string]> = [
  [/2160|4k|uhd/i, '4K'],
  [/1440|2k/i, '1440p'],
  [/1080/i, '1080p'],
  [/720/i, '720p'],
  [/480/i, '480p'],
  [/360/i, '360p'],
  [/auto/i, 'Auto'],
];

export function normalizeQuality(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return 'Auto';
  if (/^\d+p$/i.test(value)) return value.toLowerCase();
  for (const [re, label] of QUALITIES) {
    if (re.test(value)) return label;
  }
  return value;
}

/** Height implied by a label — `4K` → 2160, `1080p` → 1080, unknown → 0. */
export function qualityHeight(label: string): number {
  const normalized = normalizeQuality(label);
  if (normalized === '4K') return 2160;
  if (normalized === '2K') return 1440;
  const match = /^(\d{3,4})p$/.exec(normalized);
  return match ? Number(match[1]) : 0;
}

export function qualityRank(label: string): number {
  const height = qualityHeight(label);
  if (height) return height;
  return normalizeQuality(label) === 'Auto' ? 1 : 0;
}

export function streamType(url: string): StreamType {
  return /m3u8/i.test(url) ? 'hls' : 'mp4';
}

const STREAM_PATH_RE = /\/(?:hls|stream|playlist|manifest|master|sources?|video|media|pl)\//i;

/**
 * Whether a URL is worth handing to a downloader. Deliberately generous: hosts
 * hand out extension-less HLS endpoints as often as `.m3u8`.
 */
export function isPlayable(url: string): boolean {
  if (!url || !url.startsWith('http')) return false;
  if (/\.(jpg|jpeg|png|gif|webp|css|js|woff2?|html?)(\?|$)/i.test(url)) return false;
  if (/\.(m3u8|mp4|mkv|webm|mpd)(\?|$)/i.test(url)) return true;
  if (/m3u8|manifest|mpegurl/i.test(url)) return true;
  return STREAM_PATH_RE.test(url);
}

export function absolutizeUrl(url: string, base?: string): string {
  if (url.startsWith('http')) return url;
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function isQualityLike(value: unknown): boolean {
  if (typeof value === 'number') return value >= 240 && value <= 4320;
  if (typeof value !== 'string') return false;
  return /^(\d{3,4}p?|4k|2k|uhd|hd|sd|auto|original|default)$/i.test(value.trim());
}

function labelHint(obj: Record<string, unknown>, parentKey?: string): string | undefined {
  for (const key of ['quality', 'label', 'resolution', 'name', 'size', 'height']) {
    const value = obj[key];
    if (isQualityLike(value)) return String(value);
  }
  if (parentKey && isQualityLike(parentKey)) return parentKey;
  return undefined;
}

/**
 * Best-effort extraction of sources from the many shapes embed hosts use:
 * `{sources:[{file|url|src, quality}]}`, `{stream:{qualities:{1080:{url}}}}`,
 * `{data:{...}}`. The walker is generic so unknown nesting still resolves.
 */
export function extractStreamsFromPayload(
  payload: unknown,
  referer?: string,
  provider = 'page',
  max = 12,
): ProviderStream[] {
  const out: ProviderStream[] = [];
  const seen = new Set<string>();

  const push = (rawUrl: unknown, label: unknown, declaredType?: unknown) => {
    if (typeof rawUrl !== 'string') return;
    const url = rawUrl.trim().replace(/^\\+/, '');
    if (!url.startsWith('http') || seen.has(url)) return;
    const declared = typeof declaredType === 'string' ? declaredType.toLowerCase() : '';
    const declaredHls = declared.includes('hls') || declared.includes('mpegurl');
    if (!isPlayable(url) && !declaredHls) return;
    seen.add(url);
    const quality = normalizeQuality(isQualityLike(label) ? String(label) : 'Auto');
    out.push({
      label: quality,
      quality,
      url,
      headers: streamHeaders(referer, {}, url),
      type: declaredHls || /m3u8/i.test(url) ? 'hls' : streamType(url),
      provider,
      providerId: provider.toLowerCase(),
    });
  };

  const walk = (node: unknown, depth: number, parentKey?: string) => {
    if (out.length >= max || depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, parentKey);
      return;
    }
    if (typeof node !== 'object') return;

    const obj = node as Record<string, unknown>;
    const label = labelHint(obj, parentKey);
    push(obj.file, label, obj.type);
    push(obj.url, label, obj.type);
    push(obj.src, label, obj.type);
    push(obj.link, label, obj.type);
    push(obj.playlist, 'Auto', obj.type ?? 'hls');
    push(obj.hls, 'Auto', 'hls');
    push(obj.mp4, 'Auto', 'mp4');
    push(obj.direct, label, obj.type);

    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') walk(value, depth + 1, key);
    }
  };

  walk(payload, 0);
  return out.sort((a, b) => qualityRank(b.label) - qualityRank(a.label)).slice(0, max);
}

const PAGE_URL_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s"'<>\\]*)?/gi;

/**
 * A last-resort scan of an embed page for playable URLs, plus a JSON parse when
 * the response is a document rather than markup. This is the same fallback
 * ogaro runs for the hosts it cannot settle with a plain request.
 */
export function streamsFromPage(html: string, pageUrl: string, provider = 'page'): ProviderStream[] {
  const normalized = html.replace(/\\\//g, '/');
  const trimmed = normalized.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = extractStreamsFromPayload(JSON.parse(trimmed), pageUrl, provider);
      if (parsed.length) return parsed;
    } catch {
      /* the payload was not JSON after all */
    }
  }

  const out: ProviderStream[] = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(PAGE_URL_RE)) {
    const url = match[0].replace(/\\+$/, '');
    if (!isPlayable(url) || seen.has(url)) continue;
    seen.add(url);
    const declared = /2160|4k|1440|2k|1080|720|480|360/i.exec(url)?.[0] ?? 'Auto';
    const quality = normalizeQuality(declared);
    out.push({
      label: quality,
      quality,
      url,
      headers: streamHeaders(pageUrl, {}, url),
      type: streamType(url),
      provider,
      providerId: provider.toLowerCase(),
    });
  }

  // Embedded JSON blobs (`<script>window.player = {...}`) often carry the tier
  // labels the raw URL scan cannot see.
  if (!out.length) {
    for (const match of normalized.matchAll(/(\{[^{}]*"(?:sources|stream|qualities|playlist)"[\s\S]{0,4000}?\})/g)) {
      try {
        const parsed = extractStreamsFromPayload(JSON.parse(match[1] ?? ''), pageUrl, provider);
        if (parsed.length) return parsed;
      } catch {
        /* not a complete JSON object */
      }
    }
  }

  return out.sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

const VIDLINK_REFERER = 'https://vidlink.pro';
const MOVY_API = 'https://vidrack.created.app/api/sources/movy';
const MOVY_REFERER = 'https://www.movy.bz/';
const NOVA_API = 'https://vidrack.created.app/api/sources/nova';
const VIDRACK_REFERER = 'https://vidrack.created.app/';
const RIGEL_SOURCES = 'https://movish.to/player-sources/rigel';
const RIGEL_REFERER = 'https://movish.to/';
const RIGEL_MIRROR = 'https://vidrack.created.app/api/sources/movish';
const VIDFAST_REFERER = 'https://vidfast.vc/';
const CINESRC_REFERER = 'https://cinesrc.st/';

/** vidlink.pro answers a JSON API once the TMDB id is encrypted through enc-dec.app. */
async function resolveVidlink(ctx: ResolveContext): Promise<ProviderStream[]> {
  const encoded = await encDecEncrypt('enc-vidlink', ctx.tmdbId);
  if (!encoded) throw new Error('the id encoder did not answer');
  const apiUrl = ctx.isSeries
    ? `${VIDLINK_REFERER}/api/b/tv/${encodeURIComponent(encoded)}/${ctx.season ?? 1}/${ctx.episode ?? 1}?multiLang=0`
    : `${VIDLINK_REFERER}/api/b/movie/${encodeURIComponent(encoded)}?multiLang=0`;
  const data = await fetchJson<Record<string, unknown>>(apiUrl, VIDLINK_REFERER, 9000);
  if (!data) throw new Error('the API request failed');
  return extractStreamsFromPayload(data, VIDLINK_REFERER, 'VidLink');
}

type CatalogSource = { url?: string; type?: string; quality?: string; label?: string; headers?: Record<string, string> };

/** The shared shape of the `vidrack.created.app` catalogue entries (movy, nova). */
function catalogUrl(base: string, ctx: ResolveContext): string {
  const id = encodeURIComponent(ctx.tmdbId);
  return ctx.isSeries
    ? `${base}?id=${id}&type=tv&season=${ctx.season ?? 1}&episode=${ctx.episode ?? 1}`
    : `${base}?id=${id}&type=movie`;
}

function streamsFromCatalog(
  sources: CatalogSource[],
  provider: string,
  fallbackReferer: string,
): ProviderStream[] {
  const out: ProviderStream[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const url = String(source.url ?? '').trim();
    if (!url.startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    const declared = source.headers?.Referer ?? source.headers?.referer;
    const referer = typeof declared === 'string' && declared.startsWith('http') ? declared : fallbackReferer;
    const quality = normalizeQuality(source.quality ?? source.label ?? 'Auto');
    out.push({
      label: quality,
      quality,
      url,
      headers: streamHeaders(referer, {}, url),
      type: source.type === 'hls' || source.type === 'mp4' ? source.type : /\/pl\/|m3u8/i.test(url) ? 'hls' : streamType(url),
      provider,
      providerId: provider.toLowerCase(),
    });
  }
  return out.sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
}

async function resolveMovy(ctx: ResolveContext): Promise<ProviderStream[]> {
  const data = await fetchJson<{ sources?: CatalogSource[] }>(catalogUrl(MOVY_API, ctx), MOVY_REFERER, 7000);
  if (!data) throw new Error('the endpoint request failed');
  if (!Array.isArray(data.sources)) return [];
  return streamsFromCatalog(data.sources, 'Movy', MOVY_REFERER);
}

async function resolveNova(ctx: ResolveContext): Promise<ProviderStream[]> {
  const data = await fetchJson<{ sources?: CatalogSource[] }>(catalogUrl(NOVA_API, ctx), VIDRACK_REFERER, 8000);
  if (!data) throw new Error('the endpoint request failed');
  if (!Array.isArray(data.sources)) return [];
  return streamsFromCatalog(data.sources, 'Aurora', VIDRACK_REFERER);
}

/** The `movish.to` host, with the same CDN reached through the other catalogue as a mirror. */
async function resolveRigel(ctx: ResolveContext): Promise<ProviderStream[]> {
  const primary = await fetchJson<{ streams?: CatalogSource[] }>(
    ctx.isSeries
      ? `${RIGEL_SOURCES}/tv/${encodeURIComponent(ctx.tmdbId)}/${ctx.season ?? 1}/${ctx.episode ?? 1}`
      : `${RIGEL_SOURCES}/movie/${encodeURIComponent(ctx.tmdbId)}`,
    RIGEL_REFERER,
    7000,
  );

  let listed: CatalogSource[] = Array.isArray(primary?.streams) ? primary.streams : [];
  let answered = primary !== null;
  if (!listed.length) {
    const mirror = await fetchJson<{ streams?: CatalogSource[]; sources?: CatalogSource[] }>(
      catalogUrl(RIGEL_MIRROR, ctx),
      RIGEL_REFERER,
      8000,
    );
    answered = answered || mirror !== null;
    if (Array.isArray(mirror?.streams)) listed = mirror.streams;
    else if (Array.isArray(mirror?.sources)) listed = mirror.sources;
  }

  if (!listed.length) {
    if (!answered) throw new Error('neither endpoint answered');
    return [];
  }
  return streamsFromCatalog(listed, 'Rigel', RIGEL_REFERER);
}

/**
 * vidfast.vc hands out nothing without the player bundle's own encrypted POST,
 * which only a real browser can produce (ogaro delegates it to Playwright, this
 * dashboard has no browser). What is left is the enc-dec route check and the
 * page scan — the same fallback ogaro runs with no browser configured.
 */
async function resolveVidfast(ctx: ResolveContext): Promise<ProviderStream[]> {
  const direct = await fetchJson<{ result?: { stream?: string } | string; stream?: string }>(
    `${ENC_DEC_BASE}/enc-vidfast?text=${encodeURIComponent(ctx.tmdbId)}`,
    VIDFAST_REFERER,
    8000,
  ).catch(() => null);
  const candidate = (typeof direct?.result === 'object' ? direct.result?.stream : undefined) ?? direct?.stream;
  if (typeof candidate === 'string' && isPlayable(candidate)) {
    return extractStreamsFromPayload({ url: candidate, type: 'hls' }, VIDFAST_REFERER, 'VidFast');
  }

  const pageUrl = ctx.isSeries
    ? `${VIDFAST_REFERER}tv/${encodeURIComponent(ctx.tmdbId)}/${ctx.season ?? 1}/${ctx.episode ?? 1}/`
    : `${VIDFAST_REFERER}movie/${encodeURIComponent(ctx.tmdbId)}`;
  const html = await fetchText(pageUrl, VIDFAST_REFERER, 6000);
  if (!html) throw new Error('the page request failed');
  return streamsFromPage(html, pageUrl, 'VidFast');
}

/** cinesrc.st sits behind a DDoS-Guard challenge; only the plain scan can answer here. */
async function resolveCinesrc(ctx: ResolveContext): Promise<ProviderStream[]> {
  const pageUrl = ctx.isSeries
    ? `${CINESRC_REFERER}embed/tv/${encodeURIComponent(ctx.tmdbId)}/${ctx.season ?? 1}/${ctx.episode ?? 1}`
    : `${CINESRC_REFERER}embed/movie/${encodeURIComponent(ctx.tmdbId)}`;
  const html = await fetchText(pageUrl, CINESRC_REFERER, 7000);
  if (!html) throw new Error('the page request failed (or a challenge blocked it)');
  return streamsFromPage(html, pageUrl, 'CineSrc');
}

export interface ProviderFailure {
  provider: string;
  providerId: string;
  reason: string;
}

function wrap(
  id: string,
  name: string,
  kind: 'api' | 'html',
  resolve: (ctx: ResolveContext) => Promise<ProviderStream[]>,
  timeoutMs?: number,
): EmbedProvider {
  return {
    id,
    name,
    kind,
    ...(timeoutMs ? { timeoutMs } : {}),
    async resolve(ctx) {
      const streams = await resolve(ctx);
      // A provider's own name is attached here rather than by each resolver.
      return streams.map((stream) => ({ ...stream, provider: name, providerId: id }));
    },
  };
}

/**
 * The hosts this dashboard sweeps, in the order they are tried.
 *
 * The order is a preference, not a measurement: the two one-hop JSON catalogues
 * answer in a second and carry real tier labels, so they are first; the two hosts
 * ogaro resolves in a browser come last because only a page scan can answer for
 * them here.
 */
export const PROVIDERS: EmbedProvider[] = [
  wrap('movy', 'Movy', 'api', resolveMovy),
  wrap('aurora', 'Aurora', 'api', resolveNova),
  wrap('rigel', 'Rigel', 'api', resolveRigel),
  wrap('vidlink', 'VidLink', 'api', resolveVidlink),
  wrap('vidfast', 'VidFast', 'api', resolveVidfast, 15_000),
  wrap('cinesrc', 'CineSrc', 'html', resolveCinesrc, 12_000),
];

export function providerCatalog(): Array<{ id: string; name: string; kind: string }> {
  return PROVIDERS.map((provider) => ({ id: provider.id, name: provider.name, kind: provider.kind }));
}

export function selectProviders(ids?: string[]): EmbedProvider[] {
  if (!ids || !ids.length) return PROVIDERS;
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  const chosen = PROVIDERS.filter((provider) => wanted.has(provider.id));
  return chosen.length ? chosen : PROVIDERS;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 9000;

function withTimeout(provider: EmbedProvider, ctx: ResolveContext): Promise<ProviderStream[] | ProviderFailure> {
  const budget = provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ProviderStream[] | ProviderFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ provider: provider.name, providerId: provider.id, reason: `no answer within ${Math.round(budget / 1000)}s` }),
      budget,
    );
    provider
      .resolve(ctx)
      .then((streams) => finish(streams))
      .catch((error: unknown) => finish({ provider: provider.name, providerId: provider.id, reason: describeError(error) }));
  });
}

export function describeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return 'the request failed';
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

export interface SweepResult {
  /** Every playable source, best quality first, provider order as tie-break. */
  sources: ProviderStream[];
  failures: ProviderFailure[];
}

/** Runs every selected provider at once; each one is bounded by its own cap. */
export async function sweepProviders(ctx: ResolveContext, only?: string[]): Promise<SweepResult> {
  const providers = selectProviders(only);
  const settled = await Promise.all(providers.map((provider) => withTimeout(provider, ctx)));
  const sources: ProviderStream[] = [];
  const failures: ProviderFailure[] = [];
  settled.forEach((entry) => {
    if (Array.isArray(entry)) sources.push(...entry);
    else failures.push(entry);
  });
  sources.sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
  return { sources, failures };
}

/* ------------------------------------------------------------------ */
/* Input resolution: a pasted URL, whatever kind it is                 */
/* ------------------------------------------------------------------ */

export interface InputResolution {
  /** The playable URL to download, when the input already was one. */
  direct?: { url: string; headers: Record<string, string>; type: StreamType };
  /** Sources found by scraping an embed page. */
  sources?: ProviderStream[];
  /** How the input was understood, shown in the dashboard. */
  note: string;
}

const EMBED_ROUTES: Array<{ host: RegExp; providerId: string }> = [
  { host: /(^|\.)vidlink\.pro$/i, providerId: 'vidlink' },
  { host: /(^|\.)vidfast\.vc$/i, providerId: 'vidfast' },
  { host: /(^|\.)cinesrc\.st$/i, providerId: 'cinesrc' },
  { host: /(^|\.)movish\.to$/i, providerId: 'rigel' },
];

/** TMDB id (plus season/episode) out of an embed URL, when it carries one. */
export function targetFromEmbedUrl(raw: string): JobTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  // Shapes: /movie/123, /embed/movie/123, /tv/123/1/2, /embed/tv/123/1/2
  const movieIndex = parts.findIndex((part) => part === 'movie');
  const tvIndex = parts.findIndex((part) => part === 'tv');
  if (movieIndex !== -1) {
    const tmdbId = Number(parts[movieIndex + 1]);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return undefined;
    return { kind: 'movie', tmdbId: Math.floor(tmdbId), title: `TMDB ${Math.floor(tmdbId)}` };
  }
  if (tvIndex !== -1) {
    const tmdbId = Number(parts[tvIndex + 1]);
    const season = Number(parts[tvIndex + 2] ?? 1);
    const episode = Number(parts[tvIndex + 3] ?? 1);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return undefined;
    return {
      kind: 'episode',
      tmdbId: Math.floor(tmdbId),
      title: `TMDB ${Math.floor(tmdbId)}`,
      season: Number.isFinite(season) && season > 0 ? Math.floor(season) : 1,
      episode: Number.isFinite(episode) && episode > 0 ? Math.floor(episode) : 1,
    };
  }
  return undefined;
}

/**
 * Understands a pasted source: a direct media URL, a known embed page (routed to
 * the provider that knows it), or any other page (scanned for playable URLs).
 */
export async function resolveInputUrl(raw: string, title?: string): Promise<InputResolution> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('that is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) URLs are supported');
  }

  const looksMedia = /\.(m3u8|mp4|mkv|webm|ts|mpd)(\?|$)/i.test(parsed.pathname) || /m3u8/i.test(raw);
  if (looksMedia) {
    return {
      direct: { url: raw, headers: streamHeaders(undefined, {}, raw), type: streamType(raw) },
      note: 'direct media URL',
    };
  }

  const route = EMBED_ROUTES.find((entry) => entry.host.test(parsed.hostname));
  const target = targetFromEmbedUrl(raw);
  if (route && target) {
    const ctx = contextFor(title ? { ...target, title } : target);
    const providers = selectProviders([route.providerId]);
    const settled = await Promise.all(providers.map((provider) => withTimeout(provider, ctx)));
    const sources: ProviderStream[] = [];
    for (const entry of settled) if (Array.isArray(entry)) sources.push(...entry);
    sources.sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
    if (!sources.length) throw new Error(`the ${route.providerId} page did not hand out a playable source`);
    return { sources, note: `embed page resolved through ${route.providerId}` };
  }

  const referer = `${parsed.origin}/`;
  const html = await fetchText(raw, referer, 12_000);
  if (!html) throw new Error('could not fetch that page');
  const sources = streamsFromPage(html, raw, parsed.hostname);
  if (!sources.length) throw new Error('no playable URL found on that page');
  return { sources, note: `page scanned (${parsed.hostname})` };
}
