import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampCheckInterval } from './check-schedule';
import { builtInProxies, parseProxyList, type ProxyEndpoint } from './proxies';
import { clampPresignExpiry } from './r2';
import { normalizeLanguage } from './subtitles';
import { clampChunkBytes } from './tus';

const here = path.dirname(fileURLToPath(import.meta.url));

export const HARD_MAX_ACCOUNTS = 30;
export const HARD_MAX_CONCURRENCY = 10;
export const DEFAULT_MAX_ACCOUNTS = 30;
export const DEFAULT_CONCURRENCY = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB per file, streamed straight to disk

/** `tus` survives dropped connections; `put` is the single-request fallback. */
export type UploadMode = 'tus' | 'put';

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  dataDir: string;
  /**
   * Where working files live: a scraped source's spool while it is downloaded
   * and uploaded, and a manual upload's `.bin` until it reaches Bunny. Set
   * `SCRATCH_DIR` to move this onto a RAM disk (see [resolveUploadsDir]).
   */
  uploadsDir: string;
  dbPath: string;
  secretPath: string;
  publicDir: string;
  mock: boolean;
  uploadMode: UploadMode;
  tusChunkBytes: number;
  /** Default for the watched folder; the setting in the dashboard wins once set. */
  watchDir?: string;
  watchIntervalMs: number;
  watchMinAgeMs: number;
  maxAccounts: number;
  perAccountConcurrency: number;
  tickIntervalMs: number;
  pollIntervalMs: number;
  maxPollsPerJob: number;
  /** Parallel segment downloads for a scraped stream. */
  streamConcurrency: number;
  /** Whether the dashboard may start a Cloudflare quick tunnel for Bunny to pull from. */
  tunnelEnabled: boolean;
  /** Whether a missing cloudflared may be downloaded into `.tools/`. */
  tunnelDownload: boolean;
  /** An externally managed tunnel URL, used instead of spawning cloudflared. */
  tunnelPublicUrl?: string;
  cloudflaredPath?: string;
  /** Per-attempt ceiling for outbound control-plane calls (Bunny API, playlists). */
  networkTimeoutMs: number;
  /** Extra attempts after the first, for a flaky network path. */
  networkRetries: number;
  /** Login for the dashboard itself; absent when no password is configured. */
  dashboardUser?: string;
  dashboardPassword?: string;
  /** Smallest gap between two scrape requests to the same host. */
  scrapeMinIntervalMs: number;
  /** Base cooldown after a host refuses (403/429/5xx or a bot challenge). */
  scrapeCooldownMs: number;
  /**
   * Rewrite requests aimed at these hosts through a replacement base first.
   * The intended use is a bunny.net pull zone whose origin is the host: the
   * request then leaves from Bunny's edge instead of this machine.
   */
  scrapeEgress: Record<string, string>;
  /**
   * The exits the scrape layer sends its requests through, in order.
   *
   * Built in (see [BUILT_IN_PROXIES]); `SCRAPER_PROXIES` replaces the list, and
   * `SCRAPER_PROXIES=off` empties it, which puts the scraper back on this
   * machine's own connection. Empty means "no proxies": nothing in the download
   * path ever reads this list, so it cannot make a video download metered.
   */
  scrapeProxies: ProxyEndpoint[];
  /** What the proxy plan allows, in bytes. Only ever used to warn. */
  scrapeProxyBudgetBytes: number;
  /** Carry a stream's subtitle tracks into Bunny as caption tracks. */
  subtitleUpload: boolean;
  /**
   * The languages a title should end up with, in order.
   *
   * One target produces one translated caption; a list produces one per
   * language, all from the same source track — Arabic, French and Spanish out of
   * one English subtitle, if that is what the library needs.
   */
  subtitleTargetLanguages: string[];
  /**
   * Translate a title's missing target-language track with DeepL.
   *
   * On by default: the engine is DeepL's own public endpoint, so there is no
   * account or key in front of the first Arabic subtitle. Switched off, the
   * dashboard still carries every track the stream had — it just never invents
   * the one that was missing.
   */
  subtitleTranslate: boolean;
  /** Overrides the endpoint the DeepL scraper posts to; absent means deepl.com. */
  subtitleTranslateEndpoint?: string;
  /**
   * Cloudflare R2 (S3 API) where a finished title is copied — every MP4
   * rendition, every still, every caption — before Bunny is asked to let the
   * video go. Absent means the dashboard never archives anything.
   */
  r2?: R2ArchiveConfig;
}

/**
 * Where a finished title goes, and what "archive" means once it is there.
 *
 * There is deliberately no way to point this at Bunny: the archive is the copy
 * that survives Bunny, so an archive whose destination is Bunny would be a
 * delete with extra steps.
 */
export interface R2ArchiveConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Defaults to `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** `https://pub-….r2.dev` or a custom domain, so the archive can be played back. */
  publicBase?: string;
  /** The folder every title is filed under, e.g. `archive`. */
  prefix: string;
  /** Whether a finished publish is archived without being asked. */
  enabled: boolean;
  /** Keep the video in Bunny after a successful archive (default: remove it). */
  keepBunny: boolean;
  /**
   * How long a signed playback URL stays valid, in seconds (default 300).
   *
   * The dashboard serves an archived title by redirecting to a presigned R2 URL,
   * so playback needs no public bucket and the link expires on its own. Clamped
   * to S3's own 1 s – 7 day range.
   */
  urlTtl: number;
  /**
   * Whether the archive is re-verified on a schedule, without being asked
   * (default: yes). A copy nobody re-reads is a copy nobody knows the state of,
   * so a configured archive is checked weekly unless this is switched off.
   */
  verify: boolean;
  /** How often that pass runs, in milliseconds (default: weekly). */
  verifyIntervalMs: number;
  /**
   * Whether the archive is reconciled on a schedule, without being asked
   * (default: yes).
   *
   * A publish queues its own archive exactly once, and anything that interrupts
   * that one attempt — a restart, an R2 outage, a delete Bunny refused, the
   * switch being off at the time — would otherwise leave the title in Bunny for
   * good. The sweep is what makes "it ends up in R2 and out of Bunny" a state
   * the dashboard keeps converging to.
   */
  sweep: boolean;
  /** How often the sweep looks for work, in milliseconds (default: 5 minutes). */
  sweepIntervalMs: number;
  /** How many titles one sweep puts in line; the next one continues (default 25). */
  sweepBatch: number;
}

/** Where the automatic sweep sits by default: often enough to be invisible. */
export const SWEEP_DEFAULT_INTERVAL_MS = 5 * 60_000;
export const SWEEP_MIN_INTERVAL_MS = 30_000;
export const SWEEP_MAX_INTERVAL_MS = 24 * 60 * 60_000;
export const SWEEP_DEFAULT_BATCH = 25;
export const SWEEP_MAX_BATCH = 500;

/** `R2_SWEEP_INTERVAL_MS`, kept inside a range where a sweep is a sweep. */
export function clampSweepInterval(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return SWEEP_DEFAULT_INTERVAL_MS;
  return Math.max(SWEEP_MIN_INTERVAL_MS, Math.min(SWEEP_MAX_INTERVAL_MS, Math.floor(n)));
}

/** `R2_SWEEP_BATCH`, capped so one sweep cannot queue an entire library. */
export function clampSweepBatch(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return SWEEP_DEFAULT_BATCH;
  return Math.max(1, Math.min(SWEEP_MAX_BATCH, Math.floor(n)));
}

export function clampConcurrency(value: unknown, fallback = DEFAULT_CONCURRENCY): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(HARD_MAX_CONCURRENCY, Math.floor(n)));
}

export function clampMaxAccounts(value: unknown, fallback = DEFAULT_MAX_ACCOUNTS): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(HARD_MAX_ACCOUNTS, Math.floor(n)));
}

/** Milliseconds from the environment, falling back when it is missing or nonsense. */
export function clampIntervalMs(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/**
 * `SCRAPER_EGRESS` — `host=base` pairs, comma separated, e.g.
 * `vidfast.vc=https://vz-abc.b-cdn.net,movish.to=https://vz-def.b-cdn.net`.
 *
 * A host with no entry is contacted directly. The base must be absolute; a
 * malformed pair is ignored rather than silently rewriting requests elsewhere.
 */
export function parseEgressMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'string' || !value.trim()) return out;
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const host = trimmed.slice(0, separator).trim().toLowerCase();
    const base = trimmed.slice(separator + 1).trim().replace(/\/+$/, '');
    if (!host || !/^https?:\/\//i.test(base)) continue;
    out[host] = base;
  }
  return out;
}

/**
 * `SCRAPER_PROXIES` — where the scrape layer's requests should leave from.
 *
 * Absent means the list built into the code. An explicit `off`/`none` (or an empty
 * value) turns proxying off entirely and the scraper talks to the hosts from this
 * machine again. Anything else is parsed as proxies — `host:port:user:pass` lines,
 * comma or newline separated, exactly as a provider exports them.
 */
export function parseScrapeProxies(value: unknown): ProxyEndpoint[] {
  if (value === undefined) return builtInProxies();
  const text = String(value).trim();
  if (!text || SCRAPER_PROXIES_OFF.has(text.toLowerCase())) return [];
  return parseProxyList(text);
}

/** The values of `SCRAPER_PROXIES` that mean "send from this machine". */
const SCRAPER_PROXIES_OFF = new Set(['off', 'none', 'no', '0', 'false', 'disabled']);

/**
 * `SCRAPER_PROXY_BUDGET_MB` — what the proxy plan allows, so the dashboard can
 * say how much of it is spent. Nothing is switched off when it runs out: the
 * exits themselves stop answering (402) and the pool sets them aside.
 */
export function parseProxyBudgetBytes(value: unknown): number {
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_PROXY_BUDGET_BYTES;
  return Math.floor(mb) * 1_048_576;
}

export const DEFAULT_PROXY_BUDGET_BYTES = 1024 * 1_048_576;

/** The values of `SUBTITLE_TRANSLATOR` that mean "carry, never translate". */
const TRANSLATE_OFF = new Set(['off', 'none', 'no', '0', 'false', 'disabled', 'never']);

/**
 * `SUBTITLE_TRANSLATOR` — the text engine that makes the target-language track
 * when a title arrives without one.
 *
 * There is exactly one engine now, and it needs nothing configured: DeepL, called
 * directly on the endpoint its own translator page uses. So this returns
 * `undefined` ("do not translate") only for an explicit off-switch, and
 * `SUBTITLE_TRANSLATOR_URL` merely points the scraper somewhere else.
 */
export function parseTranslator(env: NodeJS.ProcessEnv): { endpoint?: string } | undefined {
  const value = (env.SUBTITLE_TRANSLATOR ?? '').trim().toLowerCase();
  if (TRANSLATE_OFF.has(value)) return undefined;
  const endpoint = (env.SUBTITLE_TRANSLATOR_URL ?? '').trim();
  return { ...(endpoint ? { endpoint } : {}) };
}

/**
 * A one-line note when a `.env` still carries the removed keyed translator
 * setup, so an old OpenAI/custom-endpoint block does not look like it is still
 * doing something. Purely informational: nothing about it is read.
 */
export function translatorNotice(env: NodeJS.ProcessEnv): string | undefined {
  const ignored = ['SUBTITLE_TRANSLATOR_KEY', 'SUBTITLE_TRANSLATOR_MODEL', 'DEEPL_API_KEY'].filter((key) => (env[key] ?? '').trim());
  const value = (env.SUBTITLE_TRANSLATOR ?? '').trim().toLowerCase();
  const named = value && value !== 'deepl' && value !== 'auto' && value !== 'on' && !TRANSLATE_OFF.has(value);
  if (named) ignored.unshift(`SUBTITLE_TRANSLATOR=${value}`);
  if (!ignored.length) return undefined;
  return `[config] ignoring ${ignored.join(', ')}: subtitle translation is DeepL-only and takes no key (SUBTITLE_TRANSLATOR=off turns it off).`;
}

/** The environment keys an R2 archive needs before any of them mean anything. */
const R2_REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

/**
 * `R2_*` — the Cloudflare R2 destination for the archive.
 *
 * All four of account id, key id, secret and bucket are needed or none of them
 * are: a half-filled block is a typo, and silently archiving nothing (or, worse,
 * deleting from Bunny after an upload that never happened) is exactly the kind
 * of failure that is only noticed when the video is already gone. So a partial
 * block becomes a startup notice and no archive at all.
 */
export function parseR2(env: NodeJS.ProcessEnv): { config?: R2ArchiveConfig; notice?: string } {
  const read = (key: string): string => (env[key] ?? '').trim();
  const present = R2_REQUIRED.filter((key) => read(key));
  if (present.length === 0) return {};
  if (present.length < R2_REQUIRED.length) {
    const missing = R2_REQUIRED.filter((key) => !read(key));
    return { notice: `[config] Cloudflare R2 is partly configured — also set ${missing.join(', ')}, or none of the R2_* keys at all.` };
  }
  const prefix = read('R2_PREFIX').replace(/^\/+|\/+$/g, '');
  const publicBase = read('R2_PUBLIC_BASE').replace(/\/+$/, '');
  const endpoint = read('R2_ENDPOINT');
  const urlTtl = read('R2_URL_TTL');
  const verifyInterval = read('R2_VERIFY_INTERVAL_MS');
  return {
    config: {
      accountId: read('R2_ACCOUNT_ID'),
      accessKeyId: read('R2_ACCESS_KEY_ID'),
      secretAccessKey: read('R2_SECRET_ACCESS_KEY'),
      bucket: read('R2_BUCKET'),
      ...(endpoint ? { endpoint } : {}),
      ...(publicBase ? { publicBase } : {}),
      prefix: prefix || 'archive',
      enabled: envFlag(env.R2_ARCHIVE, true),
      keepBunny: envFlag(env.R2_KEEP_BUNNY, false),
      urlTtl: clampPresignExpiry(urlTtl === '' ? undefined : urlTtl),
      // The scheduled pass is on by default for the same reason the archive
      // itself is: a title copied out of Bunny is only safe while somebody is
      // still checking that it is all there.
      verify: envFlag(env.R2_VERIFY, true),
      verifyIntervalMs: clampCheckInterval(verifyInterval === '' ? undefined : verifyInterval),
      // The reconciler too: the one-shot publish event is the fast path, and
      // this is what makes the routing survive everything the fast path doesn't.
      sweep: envFlag(env.R2_SWEEP, true),
      sweepIntervalMs: clampSweepInterval(read('R2_SWEEP_INTERVAL_MS')),
      sweepBatch: clampSweepBatch(read('R2_SWEEP_BATCH')),
    },
  };
}

/** The hard ceiling on how many languages one title can be translated into. */
export const HARD_MAX_SUBTITLE_TARGETS = 8;

/**
 * `SUBTITLE_TARGET_LANG` — one language code or a list of them.
 *
 * `ar`, `ar,fr,es` and `ar fr es` all read the same way, because the value is
 * what an operator types into a `.env`, not a machine format. Names are accepted
 * too (`Arabic, French`), since `normalizeLanguage` already knows them. Anything
 * unrecognisable is dropped rather than guessed at, the order is kept (it is the
 * order captions are produced in), duplicates collapse, and the list is capped —
 * a typo should not turn one publish into twenty translations.
 */
export function parseSubtitleTargets(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : '';
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const token = part.trim();
    // The token is offered as both a language code and a label, so `fr`, `fr-FR`
    // and `French` all resolve — `normalizeLanguage` only reads the label when
    // the code it was handed does not look like one.
    const code = normalizeLanguage(token, token);
    if (!code || out.includes(code)) continue;
    out.push(code);
    if (out.length >= HARD_MAX_SUBTITLE_TARGETS) break;
  }
  return out.length ? out : ['ar'];
}

export function parseUploadMode(value: unknown, fallback: UploadMode = 'tus'): UploadMode {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (mode === 'tus' || mode === 'put') return mode;
  return fallback;
}

function loadEnvFile(root: string, env: NodeJS.ProcessEnv): void {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * The directory that holds working files: a scraped source's spool while it is
 * being downloaded and uploaded at the same time, and a manual upload's `.bin`
 * until it reaches Bunny.
 *
 * Nothing in here is meant to outlive its job, but a stream in flight can still
 * occupy gigabytes, so `SCRATCH_DIR` exists to point the whole thing at memory —
 * `/dev/shm` on Linux, or a `tmpfs` mount — and keep real storage out of the
 * transfer entirely. Unset means `DATA_DIR/uploads`, which is where these files
 * have always lived.
 */
export function resolveUploadsDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCRATCH_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(dataDir, 'uploads');
}

/**
 * Creates the scratch directory, and says which knob was wrong when it cannot.
 *
 * A `SCRATCH_DIR` that points at a RAM disk which is not mounted is a typo worth
 * failing on, not a silent fall back to the very disk the operator asked to
 * keep the transfer away from.
 */
function ensureScratchDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const name = env.SCRATCH_DIR?.trim() ? 'SCRATCH_DIR' : 'DATA_DIR';
    throw new Error(`${name} points at ${dir}, which could not be created (${reason})`);
  }
}

/** One startup line naming the scratch directory, when it has been moved. */
export function scratchNotice(uploadsDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.SCRATCH_DIR?.trim()) return undefined;
  return `SCRATCH_DIR is set: working files go to ${uploadsDir} and are deleted as each job finishes, so nothing is kept there.`;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): AppConfig {
  const root = path.resolve(here, '..');
  loadEnvFile(root, env);
  const mock = argv.includes('--mock') || env.MOCK_PROVIDERS === '1' || env.MOCK_PROVIDERS === 'true';
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data');
  const uploadsDir = resolveUploadsDir(dataDir, env);
  ensureScratchDir(uploadsDir, env);
  const scratch = scratchNotice(uploadsDir, env);
  if (scratch) console.log(scratch);

  const port = Number(env.PORT ?? 4747);
  const translate = parseTranslator(env);
  const notice = translatorNotice(env);
  if (notice) console.warn(notice);
  const r2 = parseR2(env);
  if (r2.notice) console.warn(r2.notice);
  return {
    root,
    port: Number.isFinite(port) && port > 0 ? port : 4747,
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    uploadsDir,
    dbPath: path.join(dataDir, 'db.json'),
    secretPath: path.join(dataDir, '.secret'),
    publicDir: path.join(root, 'public'),
    mock,
    uploadMode: parseUploadMode(env.UPLOAD_MODE),
    tusChunkBytes: clampChunkBytes(env.TUS_CHUNK_BYTES),
    ...(env.WATCH_DIR ? { watchDir: env.WATCH_DIR } : {}),
    watchIntervalMs: clampIntervalMs(env.WATCH_INTERVAL_MS, 15_000, 1_000),
    watchMinAgeMs: clampIntervalMs(env.WATCH_MIN_AGE_MS, 30_000, 0),
    maxAccounts: clampMaxAccounts(env.MAX_ACCOUNTS),
    perAccountConcurrency: clampConcurrency(env.PER_ACCOUNT_CONCURRENCY),
    tickIntervalMs: Number(env.TICK_INTERVAL_MS ?? 1000),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 10_000),
    maxPollsPerJob: Number(env.MAX_POLLS_PER_JOB ?? 2160),
    streamConcurrency: clampConcurrency(env.STREAM_CONCURRENCY, 4),
    tunnelEnabled: envFlag(env.SOURCE_TUNNEL, true),
    tunnelDownload: envFlag(env.SOURCE_TUNNEL_DOWNLOAD, true),
    ...(env.TUNNEL_PUBLIC_URL ? { tunnelPublicUrl: env.TUNNEL_PUBLIC_URL.trim() } : {}),
    ...(env.CLOUDFLARED ? { cloudflaredPath: env.CLOUDFLARED.trim() } : {}),
    networkTimeoutMs: clampIntervalMs(env.NETWORK_TIMEOUT_MS, 30_000, 1_000),
    networkRetries: Math.max(0, Math.min(8, Math.floor(clampIntervalMs(env.NETWORK_RETRIES, 3, 0)))),
    // A password turns the login on; without one the dashboard is open, which is
    // why the startup log nags when it is listening beyond localhost.
    ...(env.DASHBOARD_PASSWORD
      ? { dashboardPassword: env.DASHBOARD_PASSWORD, dashboardUser: env.DASHBOARD_USER?.trim() || 'index' }
      : {}),
    scrapeMinIntervalMs: clampIntervalMs(env.SCRAPER_MIN_INTERVAL_MS, 350, 0),
    scrapeCooldownMs: clampIntervalMs(env.SCRAPER_COOLDOWN_MS, 60_000, 1_000),
    scrapeEgress: parseEgressMap(env.SCRAPER_EGRESS),
    scrapeProxies: parseScrapeProxies(env.SCRAPER_PROXIES),
    scrapeProxyBudgetBytes: parseProxyBudgetBytes(env.SCRAPER_PROXY_BUDGET_MB),
    subtitleUpload: envFlag(env.SUBTITLES, true),
    subtitleTargetLanguages: parseSubtitleTargets(env.SUBTITLE_TARGET_LANG),
    subtitleTranslate: translate !== undefined,
    ...(translate?.endpoint ? { subtitleTranslateEndpoint: translate.endpoint } : {}),
    ...(r2.config ? { r2: r2.config } : {}),
  };
}

/** `KEY=0`, `false`, `no` and `off` all turn a switch off; anything else leaves it on. */
function envFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  return fallback;
}
