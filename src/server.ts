/**
 * The dashboard API. It serves the static UI and owns every route the browser
 * needs: TMDB search/lookup, account management, job creation (file or remote
 * URL), and queue state. Account keys and the TMDB credential never leave the
 * server in clear text.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ArchiveService, type ArchiveTask, type ArchiveTaskChange } from './archive';
import { authGate } from './auth';
import { SubtitleAutoRepair, SubtitleBackfill, missingTargets } from './backfill';
import { Autopilot, AutopilotError } from './autopilot';
import { DEFAULT_MAX_BULK_JOBS, planBulk, planShow, queuedKeys, withoutQueued, type BulkOptions, type BulkPlan } from './bulk';
import { BunnyClient, BunnyError } from './bunny';
import { ALL_RESOLUTIONS, BunnyCoreClient, libraryDrift, type LibraryFinding } from './bunny-core';
import { Catalog, type CatalogEntry } from './catalog';
import { ArchiveCheckSchedule, CheckScheduleError } from './check-schedule';
import { MAX_UPLOAD_BYTES, loadConfig } from './config';
import { decryptSecret, encryptSecret, loadOrCreateSecret, maskSecret } from './crypto';
import { runDiagnostics } from './diagnostics';
import { JobService, jobTitle, sourceNameFromUrl } from './jobs';
import { HostGuard } from './hostguard';
import { DEFAULT_MIN_HEIGHT, previewScrape } from './stream';
import { configureScraper, providerCatalog, targetFromEmbedUrl } from './providers';
import { queueStats } from './queue';
import { DEFAULT_PRESIGN_SECONDS, R2Client } from './r2';
import { RelayHub } from './relay';
import { Store, type Account, type Job, type JobChangeKind, type JobSource, type JobTarget } from './store';
import { TmdbClient, TmdbError, lookupTmdb } from './tmdb';
import { DEEPL_WEB_ENDPOINT } from './translate';
import { TunnelManager } from './tunnel';
import { FolderWatcher } from './watch';
import { WATERMARK_ANCHORS, WATERMARK_CORNERS, WatermarkError, WatermarkStore, watermarkPlacement } from './watermark';

const config = loadConfig();
const secret = loadOrCreateSecret(config.secretPath);
const store = new Store(config);
/** The permanent record of everything that finished publishing. */
const catalog = new Catalog(config);

/**
 * The outbound policy for the scraping hosts: paced requests and a cooldown
 * after a refusal, so a sweep (or a whole top-rated list) cannot hammer a host
 * into blocking this machine. `SCRAPER_EGRESS` can route a host's requests
 * through a bunny.net pull zone instead, so they leave from Bunny's edge.
 */
const hostGuard = new HostGuard({
  minIntervalMs: config.scrapeMinIntervalMs,
  baseCooldownMs: config.scrapeCooldownMs,
  log: (message) => console.log(message),
});
configureScraper({ egress: config.scrapeEgress, guard: hostGuard });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tmdbClient(): TmdbClient {
  const settings = store.settings;
  const auth: { apiKey?: string; accessToken?: string } = {};
  if (settings.tmdbAccessTokenEnc) auth.accessToken = decryptSecret(secret, settings.tmdbAccessTokenEnc);
  if (settings.tmdbApiKeyEnc) auth.apiKey = decryptSecret(secret, settings.tmdbApiKeyEnc);
  return new TmdbClient(auth, { mock: config.mock });
}

function clientForAccount(account: { apiKeyEnc: string; libraryId: string }): BunnyClient {
  return new BunnyClient({
    apiKey: decryptSecret(secret, account.apiKeyEnc),
    libraryId: account.libraryId,
    mock: config.mock,
    timeoutMs: config.networkTimeoutMs,
    retries: config.networkRetries,
  });
}

/** The relay Bunny pulls from, and the tunnel that makes it reachable. */
const relay = new RelayHub();
const tunnel = new TunnelManager({
  root: config.root,
  port: config.port,
  // Mock mode never leaves the machine, so a public tunnel has nothing to serve.
  enabled: config.tunnelEnabled && !config.mock,
  allowDownload: config.tunnelDownload,
  ...(config.tunnelPublicUrl ? { externalUrl: config.tunnelPublicUrl } : {}),
  ...(config.cloudflaredPath ? { binaryPath: config.cloudflaredPath } : {}),
  log: (message) => console.log(message),
});

/**
 * The subtitle backfill: put the target language onto titles that are already
 * published without it. Nothing is re-downloaded and nothing is republished —
 * the Bunny video exists, so only the subtitle half of the pipeline runs again.
 */
const backfill = new SubtitleBackfill({
  config,
  catalog,
  client: (entry) => {
    if (!entry.accountId) return undefined;
    const account = store.account(entry.accountId);
    return account ? clientForAccount(account) : undefined;
  },
  log: (message) => console.log(message),
});

/**
 * The automatic repair: when a publish finishes without a language this machine
 * could have translated — a refused translation, most often — the same backfill
 * runs without waiting for the Library button. A rate limit clears with time,
 * which is why a failed attempt is retried a minute later.
 */
const autoRepair = new SubtitleAutoRepair({
  config,
  catalog,
  backfill,
  enabled: () => store.settings.subtitleAutoFill !== false,
  log: (message) => console.log(message),
});

/**
 * The archive destination, when one is configured.
 *
 * Built once and shared: the signer is stateless, and one client keeps the
 * request count honest for the diagnostics and the tests.
 */
const r2 = config.r2
  ? new R2Client({
      accountId: config.r2.accountId,
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
      bucket: config.r2.bucket,
      ...(config.r2.endpoint ? { endpoint: config.r2.endpoint } : {}),
    })
  : undefined;

/**
 * The watermark every account shares: one image, one placement, applied to each
 * library this dashboard creates.
 *
 * It is read fresh on every use (an upload made a second ago is visible to the
 * very next provision), and it is deliberately global — "the same position and
 * height on all the accounts" is the setting, not a per-account one.
 */
const watermark = new WatermarkStore(config);

/**
 * The account-level client, built from an *account* API key.
 *
 * Kept apart from [clientForAccount] on purpose: that one is a Stream library
 * key and talks to `video.bunnycdn.com`, this one manages the libraries
 * themselves on `api.bunny.net`. Bunny refuses each key on the other's API.
 */
function coreClient(accountApiKey: string): BunnyCoreClient {
  return new BunnyCoreClient({
    apiKey: accountApiKey,
    mock: config.mock,
    timeoutMs: config.networkTimeoutMs,
    retries: config.networkRetries,
  });
}

/** The account API key stored for an account, if it has one. */
function accountKeyOf(account: Account): string | undefined {
  if (!account.accountApiKeyEnc) return undefined;
  try {
    return decryptSecret(secret, account.accountApiKeyEnc);
  } catch {
    return undefined;
  }
}

/**
 * What every library is supposed to hold, from the dashboard's own settings.
 *
 * Read fresh on every use, so a check run after an image upload or a placement
 * change compares against the settings in force *now* rather than whatever was
 * saved when the account was added.
 */
function libraryExpectation(): {
  resolutions: string[];
  watermark: ReturnType<typeof watermarkPlacement>;
  expectImage: boolean;
  scaleByBothDimensions: boolean;
} {
  return {
    resolutions: ALL_RESOLUTIONS,
    watermark: watermarkPlacement(watermark.settings),
    expectImage: Boolean(watermark.image()),
    // Bunny's "scale video by height and width"; every library this dashboard
    // makes or fixes carries it, so a check looks for it on the same footing as
    // the ladder and the watermark.
    scaleByBothDimensions: true,
  };
}

/** One account's read-back verdict. */
interface LibraryCheckResult {
  id: string;
  name: string;
  libraryId: string;
  /** Whether Bunny answered at all — false for a refusal or no stored key. */
  checked: boolean;
  /** True only when the library was read *and* matched the settings. */
  ok: boolean;
  findings: LibraryFinding[];
  error?: string;
}

/**
 * Read every configured library back from bunny.net and compare it with what
 * this dashboard pushes.
 *
 * Nothing else would notice a library drifting: the dashboard's own settings
 * stay right while Bunny quietly keeps a narrower resolution ladder, a mark in
 * some other corner from before the watermark existed, or an image that was
 * replaced by hand. One library failing must not hide the rest, so the answer
 * is a per-account report — and an account with no stored account key is
 * reported as such rather than passed over.
 */
async function verifyLibraries(): Promise<{
  results: LibraryCheckResult[];
  total: number;
  checked: number;
  inSync: number;
  drifted: number;
  unreachable: number;
  skipped: number;
  expected: ReturnType<typeof libraryExpectation>;
}> {
  const expected = libraryExpectation();
  const results: LibraryCheckResult[] = [];
  for (const account of store.accounts) {
    const base = { id: account.id, name: account.name, libraryId: account.libraryId };
    const key = accountKeyOf(account);
    if (!key) {
      results.push({
        ...base,
        checked: false,
        ok: false,
        findings: [],
        error: 'no account API key is stored for this account — add one (Dashboard → profile → API key) and try again',
      });
      continue;
    }
    try {
      const library = await coreClient(key).getVideoLibrary(account.libraryId);
      const findings = libraryDrift(library, expected);
      results.push({ ...base, checked: true, ok: findings.length === 0, findings });
    } catch (error) {
      results.push({ ...base, checked: false, ok: false, findings: [], error: describeError(error) });
    }
  }
  return {
    results,
    total: results.length,
    checked: results.filter((result) => result.checked).length,
    inSync: results.filter((result) => result.checked && result.ok).length,
    drifted: results.filter((result) => result.checked && !result.ok).length,
    unreachable: results.filter((result) => !result.checked && Boolean(result.error) && !result.error?.startsWith('no account API key')).length,
    skipped: results.filter((result) => !result.checked && result.error?.startsWith('no account API key')).length,
    expected,
  };
}

/**
 * Put the shared watermark onto one account's library.
 *
 * One account failing must not hide the rest, so the outcome is reported per
 * account rather than thrown: the dashboard shows which libraries took it and
 * which need the account key adding first.
 */
async function applyWatermarkTo(account: Account): Promise<{
  id: string;
  name: string;
  libraryId: string;
  ok: boolean;
  imageUploaded: boolean;
  placement: ReturnType<typeof watermarkPlacement>;
  error?: string;
  note?: string;
}> {
  const placement = watermarkPlacement(watermark.settings);
  const key = accountKeyOf(account);
  if (!key) {
    return {
      id: account.id,
      name: account.name,
      libraryId: account.libraryId,
      ok: false,
      imageUploaded: false,
      placement,
      error: 'no account API key is stored for this account — add one (Dashboard → profile → API key) and try again',
    };
  }
  const image = watermark.image();
  try {
    const imageUploaded = await coreClient(key).applyWatermark(
      account.libraryId,
      placement,
      image?.bytes,
      image?.contentType ?? 'image/png',
    );
    return {
      id: account.id,
      name: account.name,
      libraryId: account.libraryId,
      ok: true,
      imageUploaded,
      placement,
      ...(imageUploaded ? {} : { note: 'no watermark image has been uploaded yet — the position and size are set, but nothing shows until one is' }),
    };
  } catch (error) {
    return {
      id: account.id,
      name: account.name,
      libraryId: account.libraryId,
      ok: false,
      imageUploaded: false,
      placement,
      error: describeError(error),
    };
  }
}

/**
 * The R2 archive: copy a finished title out of Bunny, verify it, then let Bunny
 * forget the video. `before` waits for the subtitle repair, because the archive
 * is the last thing that ever happens to a title and a caption upload that is
 * still in flight would be lost when the video is deleted.
 */
const archive = new ArchiveService({
  config,
  catalog,
  ...(r2 ? { r2 } : {}),
  client: (entry) => {
    if (!entry.accountId) return undefined;
    const account = store.account(entry.accountId);
    return account ? clientForAccount(account) : undefined;
  },
  enabled: () => store.settings.archiveToR2 !== false,
  before: (key) => autoRepair.settled(key),
  log: (message) => console.log(message),
});

const jobs = new JobService({
  store,
  config,
  clientFactory: clientForAccount,
  relay,
  tunnel,
  catalog,
  onPublished: (entry) => {
    autoRepair.consider(entry);
    archive.consider(entry);
  },
});
jobs.recover();

/**
 * The scheduled verification pass: once a week, re-read every archived title
 * and re-hash what its manifest lists.
 *
 * It is the Library's "check R2" button on a timer, so `verifiedAt` keeps up to
 * date on its own and a title that has quietly rotted in the bucket — an object
 * deleted by hand, a part-upload that landed wrong — shows up in the counts and
 * on its row without anyone thinking to look. A sweep only queues work; the
 * archive's own queue does the reading, and `R2_VERIFY=off` (or the switch in
 * Settings) turns the whole thing off.
 */
const checkSchedule = new ArchiveCheckSchedule({
  config,
  catalog,
  archive,
  log: (message) => console.log(message),
});

/**
 * The autopilot: walk TMDB's top-rated lists and queue what clears the rating
 * floor, then retry what failed, then look again.
 */
const autopilot = new Autopilot({
  config,
  store,
  jobs,
  tmdb: tmdbClient,
  // A title is "done" when it is in the queue (not failed/cancelled) or already
  // in the published catalogue, which is what keeps a re-read page free.
  doneKeys: () => {
    const keys = queuedKeys(store.jobs);
    for (const entry of catalog.all()) keys.add(entry.key);
    return keys;
  },
  log: (message) => console.log(message),
});

/** New files in the watched folder become jobs automatically. */
const watcher = new FolderWatcher({
  config,
  store,
  tmdb: tmdbClient,
  enqueue: (target, tempPath, name, bytes) => jobs.createFileJob(target, tempPath, name, bytes),
});

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function accountView(account: Account) {
  let masked: string | null = '••••';
  try {
    masked = maskSecret(decryptSecret(secret, account.apiKeyEnc));
  } catch {
    /* key cannot be read back; still show a mask */
  }
  let accountKeyMasked: string | null = null;
  if (account.accountApiKeyEnc) {
    accountKeyMasked = '••••';
    try {
      accountKeyMasked = maskSecret(decryptSecret(secret, account.accountApiKeyEnc));
    } catch {
      /* key cannot be read back; still show a mask */
    }
  }
  return {
    id: account.id,
    name: account.name,
    libraryId: account.libraryId,
    pullZoneHost: account.pullZoneHost ?? null,
    enabled: account.enabled,
    apiKeyMasked: masked,
    // Whether this account can be re-watermarked without asking for the key again.
    accountApiKeyMasked: accountKeyMasked,
    hasAccountKey: Boolean(account.accountApiKeyEnc),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function jobView(job: Job) {
  const account = job.accountId ? store.account(job.accountId) : undefined;
  // The name the video carries inside Bunny — its TMDB id — so the library can
  // be joined back to a title without reading the queue.
  return { ...job, accountName: account?.name ?? null, libraryName: jobTitle(job.target) };
}

/**
 * One row of the queue list.
 *
 * The list is polled every couple of seconds and can hold hundreds of jobs, so
 * it carries only what a row renders: the candidate ladder (up to 24 URLs a job)
 * and the per-source request headers are left out and fetched with the single
 * job the operator opens. Those two fields are what turned a 300-job queue into
 * megabytes of JSON per refresh.
 */
function jobSummaryView(job: Job) {
  const { candidates: _candidates, ...rest } = jobView(job);
  return { ...rest, source: { ...job.source, headers: undefined } };
}

function settingsView() {
  const settings = store.settings;
  const source = settings.tmdbAccessTokenEnc ? 'access-token' : settings.tmdbApiKeyEnc ? 'api-key' : null;
  return {
    mock: config.mock,
    tmdbConfigured: Boolean(source),
    tmdbCredentialSource: source,
    uploadMode: config.uploadMode,
    tusChunkBytes: config.tusChunkBytes,
    watchDir: settings.watchDir ?? null,
    watchEnabled: settings.watchEnabled !== false,
    perAccountConcurrency: settings.perAccountConcurrency,
    maxAccounts: settings.maxAccounts,
    streamConcurrency: config.streamConcurrency,
    network: { timeoutMs: config.networkTimeoutMs, retries: config.networkRetries },
    source: {
      minHeight: DEFAULT_MIN_HEIGHT,
      tunnelEnabled: config.tunnelEnabled,
      tunnelUrl: config.tunnelPublicUrl ?? null,
      cloudflaredPath: config.cloudflaredPath ?? null,
      providers: providerCatalog(),
      // The scraping hosts' outbound policy: how politely we ask, and which
      // hosts are routed somewhere else (a bunny.net pull zone, typically).
      egress: config.scrapeEgress,
      minIntervalMs: config.scrapeMinIntervalMs,
      cooldownMs: config.scrapeCooldownMs,
      cooling: hostGuard.snapshot(),
    },
    // Subtitles: whether a scrape carries the stream's caption tracks into
    // Bunny, and the text engine that fills in each missing target language when
    // the stream did not have it (never speech recognition).
    subtitles: {
      enabled: config.subtitleUpload,
      targets: config.subtitleTargetLanguages,
      translate: config.subtitleTranslate,
      // Whether a publish that came up short is filled in without being asked.
      autoFill: store.settings.subtitleAutoFill !== false,
      endpoint: config.subtitleTranslate ? config.subtitleTranslateEndpoint ?? DEEPL_WEB_ENDPOINT : null,
    },
    // The R2 archive: whether it is configured at all, where it writes, and
    // whether a finished publish is copied without being asked.
    archive: {
      configured: Boolean(config.r2),
      enabled: archive.enabled(),
      bucket: config.r2?.bucket ?? null,
      prefix: config.r2?.prefix ?? null,
      endpoint: config.r2 ? config.r2.endpoint ?? `https://${config.r2.accountId}.r2.cloudflarestorage.com` : null,
      publicBase: config.r2?.publicBase ?? null,
      keepBunny: config.r2?.keepBunny ?? false,
      // Playback is served through the dashboard, so the TTL is worth showing.
      urlTtl: config.r2?.urlTtl ?? DEFAULT_PRESIGN_SECONDS,
      auto: store.settings.archiveToR2 !== false,
      // The scheduled re-check, in short: the Settings tab reads
      // /api/archive/check for the log and the titles behind the counts.
      check: (() => {
        const check = checkSchedule.stateView();
        return {
          enabled: check.config.enabled,
          intervalMs: check.config.intervalMs,
          batchSize: check.config.batchSize,
          running: check.running,
          lastRunAt: check.lastRunAt,
          nextRunAt: check.nextRunAt,
          lastSweep: check.lastSweep,
          totals: check.totals,
        };
      })(),
    },
    // The watermark every account shares: the placement in force, whether an
    // image is stored, and the corners the dashboard may offer. The Settings tab
    // reads /api/watermark for the full picture.
    watermark: (() => {
      const state = watermark.state();
      return {
        corner: state.settings.corner,
        width: state.settings.width,
        height: state.settings.height,
        margin: state.settings.margin,
        hasImage: state.hasImage,
        bytes: state.bytes,
        corners: WATERMARK_CORNERS,
      };
    })(),
    limits: { maxAccounts: 30, perAccountConcurrency: 10, maxUploadBytes: MAX_UPLOAD_BYTES },
    catalogEntries: catalog.size,
    catalogPath: catalog.path,
  };
}

function parseTarget(input: unknown): JobTarget | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const kind = raw.kind === 'episode' ? 'episode' : raw.kind === 'movie' ? 'movie' : undefined;
  const tmdbId = Number(raw.tmdbId);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!kind || !Number.isFinite(tmdbId) || tmdbId <= 0 || !title) return undefined;
  const target: JobTarget = { kind, tmdbId: Math.floor(tmdbId), title };
  if (typeof raw.year === 'string' && raw.year) target.year = raw.year;
  if (typeof raw.posterPath === 'string') target.posterPath = raw.posterPath;
  if (kind === 'episode') {
    const season = Number(raw.season);
    const episode = Number(raw.episode);
    if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) return undefined;
    target.season = Math.floor(season);
    target.episode = Math.floor(episode);
    if (typeof raw.episodeTitle === 'string' && raw.episodeTitle) target.episodeTitle = raw.episodeTitle;
  }
  return target;
}

/**
 * A target for a source-URL job.
 *
 * Scraped jobs need a real TMDB target (that is what the hosts are asked about),
 * but a pasted URL is a job in its own right: the id is taken from the URL when
 * it carries one (an embed page does), and otherwise the job is filed under
 * whatever the operator called it. That is what `tmdbId: 0` means here — "no
 * catalogue entry", not "movie 0".
 */
function looseTarget(input: unknown, url: string, fallbackTitle: string): JobTarget | undefined {
  const parsed = parseTarget(input);
  if (parsed) return parsed;
  const fromUrl = targetFromEmbedUrl(url);
  if (fromUrl) {
    const title = typeof (input as Record<string, unknown> | null)?.title === 'string'
      ? String((input as Record<string, unknown>).title)
      : '';
    return title ? { ...fromUrl, title } : fromUrl;
  }
  const title = fallbackTitle.trim() || sourceNameFromUrl(url);
  if (!title) return undefined;
  return { kind: 'movie', tmdbId: 0, title };
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

function handle(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function fail(res: Response, error: unknown): void {
  if (error instanceof TmdbError || error instanceof BunnyError) {
    res.status(error.status ?? 502).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: describeError(error) });
}

/** Route params inside `handle()` handlers are not narrowed by path, so read them safely. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return String(value[0] ?? '');
  return '';
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();

// The login gate runs before anything else, so no route does work for a request
// that has not presented it. `/api/health` and the relay stay open to machines.
app.use(
  authGate(
    config.dashboardPassword
      ? { user: config.dashboardUser ?? 'index', password: config.dashboardPassword }
      : undefined,
  ),
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    auth: config.dashboardPassword ? 'on' : 'off',
    name: 'bunny-publisher-dashboard',
    version: '1.1.0',
    uploadMode: config.uploadMode,
    tusChunkBytes: config.uploadMode === 'tus' ? config.tusChunkBytes : null,
    streamConcurrency: config.streamConcurrency,
    tunnel: tunnel.status(),
  });
});

/* ---------------------------- relay & tunnel ---------------------------- */

// Bunny fetches this, not the browser: the path carries an unguessable token and
// serves one job's spool file while it is still being written.
app.use('/relay', relay.handle);

/**
 * Which hosts this machine can actually reach, in one request.
 *
 * The question a failed job raises is always the same — "is it my network or is
 * it the source?" — and this is the answer: Bunny's API first (publishing cannot
 * work without it), then the pull zone and every scraping host.
 */
app.get('/api/diagnostics', handle(async (_req, res) => {
  const report = await runDiagnostics({
    config,
    store,
    timeoutMs: config.networkTimeoutMs,
    tunnelUrl: tunnel.status().url,
  });
  res.json(report);
}));

app.get('/api/tunnel', (_req, res) => {
  res.json({ status: tunnel.status(), logs: tunnel.logs(30), relayJobs: store.jobs.filter((job) => job.relayToken).length });
});

app.post('/api/tunnel/start', handle(async (_req, res) => {
  const status = await tunnel.start();
  res.json({ status, logs: tunnel.logs(20) });
}));

app.post('/api/tunnel/stop', (_req, res) => {
  tunnel.stop();
  const status = tunnel.status();
  res.json({ status });
});

app.get('/api/settings', (_req, res) => {
  res.json(settingsView());
});

app.put('/api/settings', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: {
    tmdbApiKeyEnc?: string;
    tmdbAccessTokenEnc?: string;
    perAccountConcurrency?: number;
    maxAccounts?: number;
    watchDir?: string;
    watchEnabled?: boolean;
    subtitleAutoFill?: boolean;
    archiveToR2?: boolean;
  } = {};

  if (typeof body.tmdbApiKey === 'string' && body.tmdbApiKey.trim()) {
    patch.tmdbApiKeyEnc = encryptSecret(secret, body.tmdbApiKey.trim());
    patch.tmdbAccessTokenEnc = undefined;
  }
  if (typeof body.tmdbAccessToken === 'string' && body.tmdbAccessToken.trim()) {
    patch.tmdbAccessTokenEnc = encryptSecret(secret, body.tmdbAccessToken.trim());
    patch.tmdbApiKeyEnc = undefined;
  }
  if (body.clearTmdb === true) {
    patch.tmdbApiKeyEnc = undefined;
    patch.tmdbAccessTokenEnc = undefined;
  }
  if (body.perAccountConcurrency !== undefined) {
    const value = Number(body.perAccountConcurrency);
    if (!Number.isFinite(value) || value < 1 || value > 10) return void res.status(400).json({ error: 'per-account concurrency must be between 1 and 10' });
    patch.perAccountConcurrency = Math.floor(value);
  }
  if (body.maxAccounts !== undefined) {
    const value = Number(body.maxAccounts);
    if (!Number.isFinite(value) || value < 1 || value > 30) return void res.status(400).json({ error: 'the account limit must be between 1 and 30' });
    if (Math.floor(value) < store.accounts.length) return void res.status(400).json({ error: `you already have ${store.accounts.length} account(s), so the limit cannot go below that` });
    patch.maxAccounts = Math.floor(value);
  }
  if (body.watchDir !== undefined) {
    const dir = typeof body.watchDir === 'string' ? body.watchDir.trim() : '';
    if (dir) {
      const resolved = path.resolve(dir);
      if (resolved === path.resolve(config.uploadsDir) || resolved === path.resolve(config.dataDir)) {
        return void res.status(400).json({ error: 'the watched folder cannot be the uploads or data folder' });
      }
    }
    patch.watchDir = dir;
  }
  if (body.watchEnabled !== undefined) {
    if (typeof body.watchEnabled !== 'boolean') return void res.status(400).json({ error: 'watchEnabled must be true or false' });
    patch.watchEnabled = body.watchEnabled;
  }
  if (body.subtitleAutoFill !== undefined) {
    if (typeof body.subtitleAutoFill !== 'boolean') return void res.status(400).json({ error: 'subtitleAutoFill must be true or false' });
    patch.subtitleAutoFill = body.subtitleAutoFill;
  }
  if (body.archiveToR2 !== undefined) {
    if (typeof body.archiveToR2 !== 'boolean') return void res.status(400).json({ error: 'archiveToR2 must be true or false' });
    if (body.archiveToR2 && !config.r2) {
      return void res.status(400).json({ error: 'no R2 destination is configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first' });
    }
    patch.archiveToR2 = body.archiveToR2;
  }

  store.updateSettings(patch);
  res.json(settingsView());
});

/* ---------------------------- accounts ---------------------------- */

app.get('/api/accounts', (_req, res) => {
  const stats = queueStats(store.jobs, store.accounts, store.settings.perAccountConcurrency);
  res.json({
    accounts: store.accounts.map(accountView),
    usage: stats.accounts,
    maxAccounts: store.settings.maxAccounts,
    perAccountConcurrency: stats.perAccountConcurrency,
  });
});

/**
 * Add an account from details that already exist.
 *
 * The Stream library ID and key are the minimum; an account API key is optional
 * but worth giving, because it is what lets this library be re-watermarked
 * later without pasting it again.
 */
app.post('/api/accounts', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const libraryId = typeof body.libraryId === 'string' ? body.libraryId.trim() : String(body.libraryId ?? '').trim();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const pullZoneHost = typeof body.pullZoneHost === 'string' ? body.pullZoneHost.trim() : '';
  const accountApiKey = typeof body.accountApiKey === 'string' ? body.accountApiKey.trim() : '';
  if (!name) return void res.status(400).json({ error: 'give the account a name' });
  if (!libraryId) return void res.status(400).json({ error: 'the Stream library ID is required — or use the account API key to create a library' });
  if (!apiKey) return void res.status(400).json({ error: 'the Stream library API key is required — or use the account API key to create a library' });
  if (store.accounts.length >= store.settings.maxAccounts) {
    return void res.status(400).json({ error: `account limit reached (${store.settings.maxAccounts})` });
  }
  const account = store.addAccount({
    name,
    libraryId,
    apiKeyEnc: encryptSecret(secret, apiKey),
    ...(accountApiKey ? { accountApiKeyEnc: encryptSecret(secret, accountApiKey) } : {}),
    ...(pullZoneHost ? { pullZoneHost } : {}),
  });
  res.status(201).json({ account: accountView(account) });
});

/**
 * Add an account from nothing but an account API key.
 *
 * This is the whole point of the account-level client: Bunny creates the video
 * library, hands back the Stream key only it knows, and the library comes out
 * with every resolution enabled and wearing the shared watermark — so the only
 * two things that ever have to be copied out of the Bunny dashboard are the
 * account API key (once) and the watermark image (once).
 *
 * A failure after the library was made does not lose it: Bunny's error is
 * reported, and because nothing is stored until the library exists, the
 * operator can retry with the same name or finish the job by hand.
 */
app.post('/api/accounts/provision', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const accountApiKey = typeof body.accountApiKey === 'string' ? body.accountApiKey.trim() : '';
  if (!name) return void res.status(400).json({ error: 'give the account a name — it becomes the name of the Bunny Stream library' });
  if (!accountApiKey) {
    return void res.status(400).json({ error: 'the account API key is required (Bunny dashboard → profile → Edit account details → API Key)' });
  }
  if (store.accounts.length >= store.settings.maxAccounts) {
    return void res.status(400).json({ error: `account limit reached (${store.settings.maxAccounts})` });
  }
  const image = watermark.image();
  const placement = watermarkPlacement(watermark.settings);
  let provisioned;
  try {
    provisioned = await coreClient(accountApiKey).provisionLibrary({
      name,
      watermark: placement,
      ...(image ? { image: image.bytes, imageContentType: image.contentType } : {}),
    });
  } catch (error) {
    fail(res, error);
    return;
  }
  const account = store.addAccount({
    name,
    libraryId: provisioned.libraryId,
    apiKeyEnc: encryptSecret(secret, provisioned.streamApiKey),
    accountApiKeyEnc: encryptSecret(secret, accountApiKey),
    ...(provisioned.pullZoneHost ? { pullZoneHost: provisioned.pullZoneHost } : {}),
  });
  res.status(201).json({
    account: accountView(account),
    // What the new library ended up as, so the dashboard can say so plainly.
    library: {
      id: provisioned.libraryId,
      name,
      pullZoneHost: provisioned.pullZoneHost ?? null,
      resolutions: ALL_RESOLUTIONS,
      // What the settings call also switched on, so the dashboard can say so.
      scaleByBothDimensions: true,
    },
    watermark: { applied: provisioned.watermarkApplied, hasImage: Boolean(image), placement },
  });
}));

app.patch('/api/accounts/:id', (req, res) => {
  const account = store.account(req.params.id);
  if (!account) return void res.status(404).json({ error: 'account not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { name?: string; libraryId?: string; apiKeyEnc?: string; accountApiKeyEnc?: string | undefined; pullZoneHost?: string; enabled?: boolean } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.libraryId === 'string' && body.libraryId.trim()) patch.libraryId = body.libraryId.trim();
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKeyEnc = encryptSecret(secret, body.apiKey.trim());
  if (typeof body.accountApiKey === 'string' && body.accountApiKey.trim()) {
    patch.accountApiKeyEnc = encryptSecret(secret, body.accountApiKey.trim());
  } else if (body.clearAccountApiKey === true) {
    patch.accountApiKeyEnc = undefined;
  }
  if (typeof body.pullZoneHost === 'string') patch.pullZoneHost = body.pullZoneHost.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  const updated = store.updateAccount(account.id, patch);
  res.json({ account: updated ? accountView(updated) : null });
});

app.delete('/api/accounts/:id', (req, res) => {
  const account = store.account(req.params.id);
  if (!account) return void res.status(404).json({ error: 'account not found' });
  const active = store.jobs.filter((job) => job.accountId === account.id && (job.status === 'uploading' || job.status === 'encoding'));
  if (active.length > 0) {
    return void res.status(409).json({ error: `${active.length} active job(s) still use this account — cancel them first` });
  }
  store.removeAccount(account.id);
  res.json({ ok: true });
});

app.post('/api/accounts/:id/test', handle(async (req, res) => {
  const account = store.account(param(req, 'id'));
  if (!account) return void res.status(404).json({ error: 'account not found' });
  try {
    const client = clientForAccount(account);
    const list = await client.listVideos(1);
    res.json({ ok: true, totalItems: list.totalItems ?? 0 });
  } catch (error) {
    res.json({ ok: false, error: describeError(error) });
  }
}));

/* ---------------------------- watermark ---------------------------- */

/** The shared watermark: the placement in force, and whether an image is stored. */
app.get('/api/watermark', (_req, res) => {
  res.json({ ...watermark.state(), anchors: WATERMARK_ANCHORS, corners: WATERMARK_CORNERS, resolutions: ALL_RESOLUTIONS });
});

/**
 * Change the placement.
 *
 * Two shapes of body arrive here and both end in the same four percentages:
 * `{ corner, margin }` for a mark pinned to a corner, or
 * `{ anchor: 'offset', left, top }` to place it by hand — `0` meaning flush
 * against that edge. Naming neither leaves the current mode alone.
 *
 * Changing it does not touch Bunny by itself — it changes what the *next* apply
 * (or provision) sends. `POST /api/watermark/apply` is the second half of that
 * pair, and the dashboard offers both.
 */
app.put('/api/watermark', (req, res) => {
  try {
    res.json({ ...watermark.updateSettings((req.body ?? {}) as Record<string, unknown>), anchors: WATERMARK_ANCHORS, corners: WATERMARK_CORNERS });
  } catch (error) {
    if (error instanceof WatermarkError) return void res.status(400).json({ error: error.message });
    throw error;
  }
});

/**
 * The image itself, as raw bytes rather than base64 inside JSON.
 *
 * It is posted as whatever the browser read the file as (`image/png` and so
 * on), which also means the route needs its own body parser: the global one
 * caps JSON at 1 MB, and a watermark is a file, not JSON.
 */
app.put('/api/watermark/image', express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    res.json(watermark.saveImage(bytes, String(req.headers['content-type'] ?? 'image/png')));
  } catch (error) {
    if (error instanceof WatermarkError) return void res.status(400).json({ error: error.message });
    throw error;
  }
});

/**
 * The stored image itself.
 *
 * The watermark panel draws the mark inside a stand-in video frame so it can be
 * dragged into place, and the browser can only do that with the bytes — which are
 * already on disk next to the database, so the route is a read of the same file
 * the upload wrote. The image is replaced in place when a new one arrives, so the
 * answer is explicitly uncacheable; the dashboard asks with a query string that
 * changes with the upload, and a cached copy would keep showing the old mark.
 */
app.get('/api/watermark/image', (_req, res) => {
  const image = watermark.image();
  if (!image) return void res.status(404).json({ error: 'no watermark image is stored' });
  res.setHeader('content-type', image.contentType);
  res.setHeader('content-length', String(image.bytes.byteLength));
  res.setHeader('cache-control', 'no-store');
  res.end(image.bytes);
});

app.delete('/api/watermark/image', (_req, res) => {
  res.json(watermark.clearImage());
});

/**
 * Put the shared watermark on every account, or on the ones named.
 *
 * Accounts that predate the watermark, or that were added by hand, are the
 * reason this exists. One failure does not stop the others: the reply is a
 * per-account report, because "which libraries still need looking at" is the
 * only useful answer to a batch.
 */
app.post('/api/watermark/apply', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(body.accountIds) ? body.accountIds.filter((id): id is string => typeof id === 'string') : [];
  const targets = ids.length
    ? ids.map((id) => store.account(id)).filter((account): account is Account => Boolean(account))
    : store.accounts;
  const results = [];
  for (const account of targets) results.push(await applyWatermarkTo(account));
  res.json({
    results,
    total: results.length,
    applied: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    hasImage: Boolean(watermark.image()),
  });
}));

/** Re-apply the shared watermark to one library. */
app.post('/api/accounts/:id/watermark', handle(async (req, res) => {
  const account = store.account(param(req, 'id'));
  if (!account) return void res.status(404).json({ error: 'account not found' });
  const result = await applyWatermarkTo(account);
  if (!result.ok) return void res.status(502).json(result);
  res.json(result);
}));

/**
 * Read every library back and report what Bunny actually holds.
 *
 * Read-only: it queues nothing, writes nothing and touches no library. Its
 * whole purpose is to say which libraries no longer match the settings, since
 * a library that has drifted looks exactly like one that has not from here.
 */
app.post('/api/accounts/verify', handle(async (_req, res) => {
  res.json(await verifyLibraries());
}));

/**
 * Put the dashboard's settings back onto one library, then report the result.
 *
 * This is the remedy for what the check finds: the resolution ladder and the
 * placement in one request, the image after it, and then a read-back so the
 * answer is what Bunny now holds rather than what was just sent.
 */
app.post('/api/accounts/:id/settings', handle(async (req, res) => {
  const account = store.account(param(req, 'id'));
  if (!account) return void res.status(404).json({ error: 'account not found' });
  const key = accountKeyOf(account);
  if (!key) {
    return void res.status(502).json({
      ok: false,
      error: 'no account API key is stored for this account — add one (Dashboard → profile → API key) and try again',
    });
  }
  const expected = libraryExpectation();
  const image = watermark.image();
  const client = coreClient(key);
  try {
    const imageUploaded = await client.applyLibrarySettings(account.libraryId, {
      placement: expected.watermark,
      resolutions: expected.resolutions,
      ...(image ? { image: image.bytes, imageContentType: image.contentType } : {}),
    });
    const findings = libraryDrift(await client.getVideoLibrary(account.libraryId), expected);
    res.json({ id: account.id, name: account.name, libraryId: account.libraryId, ok: findings.length === 0, imageUploaded, findings, placement: expected.watermark });
  } catch (error) {
    res.status(502).json({ id: account.id, name: account.name, libraryId: account.libraryId, ok: false, error: describeError(error) });
  }
}));

/* ---------------------------- watch folder ---------------------------- */

app.get('/api/watch', (_req, res) => {
  res.json(watcher.state());
});

app.post('/api/watch/scan', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  await watcher.scan({ retryUnmatched: body.retryUnmatched === true });
  res.json(watcher.state());
}));

/* ------------------------------ TMDB ------------------------------ */

app.get('/api/tmdb/search', handle(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) return void res.status(400).json({ error: 'missing search query' });
  const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)) || 1);
  try {
    res.json({ results: await tmdbClient().search(query, page) });
  } catch (error) {
    fail(res, error);
  }
}));

app.get('/api/tmdb/lookup', handle(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) return void res.status(400).json({ error: 'missing lookup value' });
  try {
    res.json({ results: await lookupTmdb(tmdbClient(), query) });
  } catch (error) {
    fail(res, error);
  }
}));

app.get('/api/tmdb/movie/:id', handle(async (req, res) => {
  const id = Number(param(req, 'id'));
  if (!Number.isFinite(id)) return void res.status(400).json({ error: 'movie id must be a number' });
  try {
    res.json({ movie: await tmdbClient().movie(id) });
  } catch (error) {
    fail(res, error);
  }
}));

app.get('/api/tmdb/tv/:id', handle(async (req, res) => {
  const id = Number(param(req, 'id'));
  if (!Number.isFinite(id)) return void res.status(400).json({ error: 'show id must be a number' });
  try {
    res.json({ show: await tmdbClient().tv(id) });
  } catch (error) {
    fail(res, error);
  }
}));

app.get('/api/tmdb/tv/:id/season/:season', handle(async (req, res) => {
  const id = Number(param(req, 'id'));
  const season = Number(param(req, 'season'));
  if (!Number.isFinite(id) || !Number.isFinite(season)) return void res.status(400).json({ error: 'show id and season must be numbers' });
  try {
    res.json({ episodes: await tmdbClient().season(id, season) });
  } catch (error) {
    fail(res, error);
  }
}));

/* ------------------------------ jobs ------------------------------ */

app.post('/api/jobs/upload', (req, res) => {
  const metaRaw = typeof req.query.meta === 'string' ? req.query.meta : '';
  let meta: unknown;
  try {
    meta = metaRaw ? JSON.parse(metaRaw) : undefined;
  } catch {
    return void res.status(400).json({ error: 'invalid ?meta= — expected JSON' });
  }
  const target = parseTarget(meta);
  if (!target) return void res.status(400).json({ error: 'invalid target metadata (need kind, tmdbId, title; episodes also need season and episode)' });
  const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : 'upload.bin';

  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return void res.status(413).json({ error: 'that file is larger than the configured upload cap' });
  }

  const jobId = crypto.randomUUID();
  const tempPath = path.join(config.uploadsDir, `${jobId}.bin`);
  const sink = fs.createWriteStream(tempPath);
  let received = 0;
  let responded = false;
  const finish = (status: number, body: unknown) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      req.destroy();
      sink.destroy();
      fs.rmSync(tempPath, { force: true });
      finish(413, { error: 'that file is larger than the configured upload cap' });
    }
  });
  req.on('aborted', () => {
    sink.destroy();
    fs.rmSync(tempPath, { force: true });
  });
  sink.on('error', (error) => {
    fs.rmSync(tempPath, { force: true });
    finish(500, { error: `could not store the upload: ${describeError(error)}` });
  });
  sink.on('finish', () => {
    const job = jobs.createFileJob(target, tempPath, name, received || undefined);
    finish(201, { job: jobView(job) });
  });
  req.pipe(sink);
});

app.post('/api/jobs/remote', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = parseTarget(body.target);
  if (!target) return void res.status(400).json({ error: 'invalid target metadata' });
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return void res.status(400).json({ error: 'a source URL is required' });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return void res.status(400).json({ error: 'that is not a valid URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return void res.status(400).json({ error: 'only http(s) URLs are supported' });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : sourceNameFromUrl(url);
  res.status(201).json({ job: jobView(jobs.createUrlJob(target, url, name)) });
});

/* --------------------------- scrape & sources --------------------------- */

app.get('/api/sources/providers', (_req, res) => {
  res.json({
    providers: providerCatalog(),
    minHeight: DEFAULT_MIN_HEIGHT,
    // Hosts that refused us and are serving a cooldown, with the reason and the
    // time they become usable again.
    cooling: hostGuard.snapshot(),
  });
});

/** What a scrape would pick, without downloading anything. */
app.post('/api/sources/preview', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = parseTarget(body.target);
  if (!target) return void res.status(400).json({ error: 'a target (kind, tmdbId, title) is required' });
  const only = Array.isArray(body.only) ? body.only.filter((id): id is string => typeof id === 'string') : undefined;
  const minHeight = Number(body.minHeight ?? DEFAULT_MIN_HEIGHT);
  try {
    const preview = await previewScrape(target, {
      ...(only && only.length ? { only } : {}),
      minHeight: Number.isFinite(minHeight) ? minHeight : DEFAULT_MIN_HEIGHT,
      limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 5,
    });
    res.json(preview);
  } catch (error) {
    fail(res, error);
  }
}));

/**
 * One click: download the source ourselves and hand it to Bunny.
 *
 * Two modes, one endpoint: `scrape` resolves the target across the hosts, and
 * `source` starts from a URL the operator pasted (a playlist, a media file, or an
 * embed page, which is resolved first).
 */
app.post('/api/jobs/source', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const rawUrl = typeof body.url === 'string' ? body.url : '';

  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return void res.status(400).json({ error: 'only http(s) URLs are supported' });
      }
    } catch {
      return void res.status(400).json({ error: 'that is not a valid URL' });
    }
  }

  const target = looseTarget(body.target, rawUrl, title);
  if (!target) return void res.status(400).json({ error: 'a target or a source URL is required' });

  const mode: 'scrape' | 'source' = url ? 'source' : 'scrape';
  if (mode === 'scrape' && !target.tmdbId) {
    return void res.status(400).json({ error: 'direct scraping needs a TMDB id — pick the title from the search results' });
  }

  const only = Array.isArray(body.only)
    ? body.only.filter((id): id is string => typeof id === 'string')
    : undefined;
  const minHeight = Number(body.minHeight ?? DEFAULT_MIN_HEIGHT);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : url ? sourceNameFromUrl(url) : jobTitle(target);

  const job = jobs.createStreamJob(target, {
    mode,
    ...(url ? { input: url } : {}),
    ...(only && only.length ? { only } : {}),
    // `0` is meaningful ("whatever the host has"), so only a nonsense value falls back.
    minHeight: Number.isFinite(minHeight) && minHeight >= 0 ? minHeight : DEFAULT_MIN_HEIGHT,
    name,
  });
  res.status(201).json({ job: jobView(job) });
});

/* ------------------------------- bulk ------------------------------- */

function bulkLines(body: Record<string, unknown>): string[] {
  const source = Array.isArray(body.lines)
    ? body.lines.filter((line): line is string => typeof line === 'string')
    : typeof body.text === 'string'
      ? body.text.split(/\r?\n/)
      : [];
  return source.map((line) => line.trim()).filter((line) => Boolean(line) && !line.startsWith('#'));
}

function bulkOptions(body: Record<string, unknown>): BulkOptions {
  const seasons = Array.isArray(body.seasons)
    ? body.seasons.map((value) => Math.floor(Number(value))).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const maxJobs = Number(body.maxJobs);
  return {
    expandSeries: body.expandSeries !== false,
    ...(seasons.length ? { seasons } : {}),
    ...(Number.isFinite(maxJobs) && maxJobs > 0 ? { maxJobs: Math.floor(maxJobs) } : {}),
  };
}

/**
 * Creates the planned jobs, minus the targets that are already in the queue.
 *
 * One call can be hundreds of jobs (a whole series), so the report is what the
 * caller gets back: how many were created, which lines were skipped and why, and
 * whether the cap stopped the list short. Failed and cancelled jobs do not block
 * a title — queueing it again is how a batch is retried.
 */
function queuePlan(plan: BulkPlan, body: Record<string, unknown>) {
  const declared = Number(body.minHeight ?? DEFAULT_MIN_HEIGHT);
  const minHeight = Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_MIN_HEIGHT;
  const only = Array.isArray(body.only) ? body.only.filter((id): id is string => typeof id === 'string') : [];
  const { fresh, skipped: duplicates } =
    body.skipQueued === false
      ? { fresh: plan.queued, skipped: [] as Array<{ line: string; reason: string }> }
      : withoutQueued(plan.queued, queuedKeys(store.jobs));
  const created: Job[] = [];
  const skipped = [...plan.skipped, ...duplicates];
  let movies = 0;
  let episodes = 0;

  for (const entry of fresh) {
    created.push(
      jobs.createStreamJob(entry.target, {
        mode: 'scrape',
        minHeight,
        ...(only.length ? { only } : {}),
      }),
    );
    if (entry.target.kind === 'movie') movies += 1;
    else episodes += 1;
  }

  return {
    created: created.map(jobView),
    skipped: skipped.slice(0, 100),
    counts: { movies, episodes },
    truncated: plan.truncated,
  };
}

/**
 * One call, one list: names, TMDB ids, IMDb ids or themoviedb.org links, one per
 * line, movies and shows mixed. Shows become every episode — or the season a
 * line pins (`Breaking Bad S03`) or the single episode it names (`Show S02E05`).
 */
app.post('/api/jobs/bulk', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lines = bulkLines(body);
  if (!lines.length) return void res.status(400).json({ error: 'paste at least one title, id or link' });
  const plan = await planBulk(tmdbClient(), lines, bulkOptions(body));
  res.status(201).json(queuePlan(plan, body));
}));

/** Every episode of one show — the season the UI has open, or the whole run. */
app.post('/api/jobs/series', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = (body.target ?? {}) as Record<string, unknown>;
  const tmdbId = Math.floor(Number(raw.tmdbId));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return void res.status(400).json({ error: "the show's TMDB id is required" });
  const options = bulkOptions(body);
  const targets = await planShow(tmdbClient(), tmdbId, options.seasons?.length ? { seasons: options.seasons } : {});
  const label = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `show ${tmdbId}`;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_BULK_JOBS;
  const plan: BulkPlan = {
    queued: targets.slice(0, maxJobs).map((target) => ({ line: label, target })),
    skipped: [],
    truncated: targets.length > maxJobs,
  };
  res.status(201).json(queuePlan(plan, body));
}));

/** Retry every failed job in one click — what a bad night of sources needs. */
app.post('/api/jobs/retry-failed', (_req, res) => {
  const failed = [...store.jobs].filter((job) => job.status === 'failed');
  const retried: Job[] = [];
  for (const job of failed) {
    const next = jobs.retry(job.id);
    if (next) retried.push(next);
  }
  res.json({ retried: retried.length, jobs: retried.map(jobView) });
});

app.get('/api/jobs', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit ?? 200)) || 200));
  const all = [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = status ? all.filter((job) => job.status === status) : all;
  res.json({
    jobs: filtered.slice(0, limit).map(jobSummaryView),
    stats: queueStats(store.jobs, store.accounts, store.settings.perAccountConcurrency),
  });
});

/** The full job — its candidate ladder included — for the row the operator opens. */
app.get('/api/jobs/:id', (req, res) => {
  const job = store.job(param(req, 'id'));
  if (!job) return void res.status(404).json({ error: 'job not found' });
  res.json({ job: jobView(job) });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const before = store.job(req.params.id);
  if (!before) return void res.status(404).json({ error: 'job not found' });
  if (before.status !== 'failed' && before.status !== 'cancelled') {
    return void res.status(409).json({ error: 'only failed or cancelled jobs can be retried' });
  }
  const job = jobs.retry(before.id);
  res.json({ job: job ? jobView(job) : null });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const before = store.job(req.params.id);
  if (!before) return void res.status(404).json({ error: 'job not found' });
  const job = jobs.cancel(before.id);
  res.json({ job: job ? jobView(job) : null });
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return void res.status(404).json({ error: 'job not found' });
  if (!jobs.remove(job.id)) return void res.status(409).json({ error: 'cancel the job before deleting it' });
  res.json({ ok: true });
});

app.get('/api/queue/stats', (_req, res) => {
  res.json(queueStats(store.jobs, store.accounts, store.settings.perAccountConcurrency));
});

/* ------------------------------ live queue ------------------------------ */

/**
 * How long job changes are gathered before they go out.
 *
 * A downloading job moves its byte counter dozens of times a second; sending
 * each of those would be a flood of near-identical messages. Everything that
 * happens inside this window is folded into one batch, and a job that changed
 * five times is sent once — in the state it holds when the window closes.
 */
const LIVE_FLUSH_MS = 250;

/** A comment line now and then keeps idle proxies from closing the stream. */
const LIVE_HEARTBEAT_MS = 15_000;

/**
 * The queue, pushed instead of polled.
 *
 * The browser opens one long-lived `text/event-stream` and the server sends a
 * `jobs` delta whenever something changes — only the rows that moved, each with
 * the same shape as a list row. The browser patches those rows in place, so an
 * update never rebuilds the table: scroll position, the selection and the open
 * job detail all survive it. `stats` follows the queue counters, `catalog`
 * announces a title that finished publishing, and `hello` opens the stream with
 * the current state so a late subscriber is never showing a stale badge.
 *
 * The stream respects the same login gate as every other `/api` route, and the
 * browser's event source sends the credentials it already cached.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Behind a buffering reverse proxy this is what stops events piling up in
    // the proxy instead of reaching the browser.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let open = true;
  const write = (chunk: string): void => {
    if (!open) return;
    try {
      res.write(chunk);
    } catch {
      // A client that vanished mid-write must not take the server down with it.
      open = false;
    }
  };
  const send = (event: string, data: unknown): void => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const currentStats = () => queueStats(store.jobs, store.accounts, store.settings.perAccountConcurrency);
  let lastStats = '';
  const pushStats = (): void => {
    const next = JSON.stringify(currentStats());
    if (next === lastStats) return;
    lastStats = next;
    send('stats', JSON.parse(next) as unknown);
  };
  // Watches the catalogue's revision, not its size: attaching a caption to a
  // title that already exists changes the Library without adding a record.
  let lastCatalog = catalog.revision;
  const pushCatalog = (): void => {
    if (catalog.revision === lastCatalog) return;
    lastCatalog = catalog.revision;
    send('catalog', { size: catalog.size, revision: catalog.revision, stats: catalog.stats() });
  };

  const liveArchive = (): ArchiveTask[] => archive.list().filter((task) => task.status === 'queued' || task.status === 'active');

  // `retry` tells the browser how long to wait before reconnecting on its own.
  write('retry: 3000\n\n');
  send('hello', { at: new Date().toISOString(), stats: currentStats(), catalog: catalog.size, archive: liveArchive() });

  // One pending entry per job, so a burst of progress ticks collapses to the
  // latest state of each row rather than a burst of messages. Archive tasks are
  // gathered the same way and for the same reason: a multi-gigabyte upload
  // reports its bytes hundreds of times, and only its latest state matters.
  const pending = new Map<string, { kind: JobChangeKind; job: Job }>();
  const pendingArchive = new Map<string, { kind: ArchiveTaskChange; task: ArchiveTask }>();
  let flushTimer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    flushTimer = undefined;
    if (pending.size > 0) {
      const deltas = [...pending.values()].map((entry) => ({ kind: entry.kind, job: jobSummaryView(entry.job) }));
      pending.clear();
      send('jobs', { jobs: deltas });
    }
    if (pendingArchive.size > 0) {
      const tasks = [...pendingArchive.values()].map((entry) => ({ kind: entry.kind, task: entry.task }));
      pendingArchive.clear();
      send('archive', { tasks });
    }
    pushStats();
    pushCatalog();
  };
  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, LIVE_FLUSH_MS);
    flushTimer.unref?.();
  };

  const unsubscribe = store.onJobChange((job, kind) => {
    pending.set(job.id, { kind, job });
    scheduleFlush();
  });
  const unsubscribeArchive = archive.onTaskChange((task, kind) => {
    pendingArchive.set(task.key, { kind, task });
    scheduleFlush();
  });

  const heartbeat = setInterval(() => write(': ping\n\n'), LIVE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = (): void => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribe();
    unsubscribeArchive();
    res.end();
  };
  req.on('close', close);
  res.on('close', close);
});

/* ---------------------------- catalogue ---------------------------- */

/**
 * A list row of the published catalogue: the entry minus its per-source detail.
 *
 * `tiers` (a handful of rungs) stays; `sources` (every probed URL, with headers)
 * is left to the single entry, exactly the way the queue list works.
 */
function catalogSummary(entry: CatalogEntry) {
  const { sources, ...rest } = entry;
  return { ...rest, sourceCount: sources.length };
}

app.get('/api/catalog/stats', (_req, res) => {
  res.json(catalog.stats());
});

/**
 * Everything that finished publishing, newest first, with a free-text search.
 *
 * `subtitles=missing|has` is the Library's "which titles still need a target
 * language?" filter — the same question the backfill asks, asked of the list so
 * a title can be picked out and filled in one at a time. A title counts as
 * missing when *any* configured language is absent, and the count of those comes
 * back alongside the list, scoped to the same search and kind.
 */
app.get('/api/catalog', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
  const subtitles = req.query.subtitles === 'missing' || req.query.subtitles === 'has' ? req.query.subtitles : '';
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(req.query.limit ?? 500)) || 500));
  const targets = config.subtitleTargetLanguages;
  const matched = catalog.search(query).filter((entry) => !kind || entry.kind === kind);
  const complete = (entry: CatalogEntry) => missingTargets(entry, targets).length === 0;
  const filtered = subtitles ? matched.filter((entry) => complete(entry) === (subtitles === 'has')) : matched;
  res.json({
    items: filtered.slice(0, limit).map(catalogSummary),
    total: catalog.size,
    matched: filtered.length,
    subtitles: { targets, missing: matched.filter((entry) => !complete(entry)).length },
    stats: catalog.stats(),
  });
});

/** One entry in full: every quality rung and every source URL it was found at. */
app.get('/api/catalog/:key', (req, res) => {
  const entry = catalog.get(param(req, 'key'));
  if (!entry) return void res.status(404).json({ error: 'no such catalogue entry' });
  res.json({ entry });
});

app.delete('/api/catalog/:key', (req, res) => {
  if (!catalog.remove(param(req, 'key'))) return void res.status(404).json({ error: 'no such catalogue entry' });
  res.json({ ok: true, stats: catalog.stats() });
});

/* ---------------------------- R2 archive ---------------------------- */

/**
 * What is waiting to be archived, what is moving right now, and how far along.
 *
 * `candidates` is what is left to copy out; `verify` and `restore` are what the
 * bucket already holds and could be re-checked or put back; `tasks` is what the
 * queue knows — queued, moving, and the recent outcomes — which is what the
 * Library renders progress from on a fresh page load, before any event arrives.
 */
app.get('/api/archive', (_req, res) => {
  res.json({
    ...archive.preview(),
    verify: archive.verifyCandidates(),
    restore: archive.restoreCandidates(),
    repair: archive.repairCandidates(),
    busy: archive.busy,
    tasks: archive.list(),
  });
});

/**
 * Queue an archive: the picked titles, or the oldest candidates when none were
 * picked.
 *
 * It answers as soon as they are in line. The copying happens on the archive's
 * own queue and its progress is streamed on `/api/events`, because moving
 * several gigabytes must not hold an HTTP request — or a browser tab — open.
 */
app.post('/api/archive', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit ?? 10)) || 10));
  res.json(archive.enqueueKeys(keys, limit));
});

/**
 * Queue a verification pass: re-read every manifest in R2 and re-hash what it
 * lists against the bucket.
 *
 * Like an archive, it answers as soon as the titles are in line: a folder of
 * several gigabytes takes minutes to re-read, and a request must not hold it.
 */
app.post('/api/archive/verify', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit ?? 25)) || 25));
  res.json(archive.enqueueKeys(keys, limit, 'verify'));
});

/**
 * Queue a restore: stream an archived title back out of R2 into a fresh Bunny
 * video, captions included.
 *
 * The archive in R2 is left alone, so this is a copy rather than a move.
 */
app.post('/api/archive/restore', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(10, Math.floor(Number(body.limit ?? 1)) || 1));
  res.json(archive.enqueueKeys(keys, limit, 'restore'));
});

/**
 * Play an archived title straight out of R2.
 *
 * Answers with a redirect to a short-lived signed URL for the title's best
 * archived rendition, which is what lets the bucket stay private: the browser
 * gets a link that works for minutes, not a credential and not a public object.
 * A player follows the redirect and can still send `Range` requests, because
 * only `host` is signed.
 *
 * Nothing is buffered here — the bytes go from R2 to the player, not through the
 * dashboard — so a feature-length film costs this process nothing but a hop.
 */
/**
 * Queue a targeted repair: mend just the objects the last check flagged.
 *
 * Each one is re-fetched from the pull zone it came from and put back only if it
 * hashes to what the manifest recorded. When Bunny no longer holds the video the
 * repair falls back to the bucket's intact copies — playback moves onto the
 * tallest surviving rendition and the objects nothing can supply are dropped from
 * the record. It runs on the archive's queue like everything else.
 */
app.post('/api/archive/repair', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(25, Math.floor(Number(body.limit ?? 5)) || 5));
  res.json(archive.enqueueKeys(keys, limit, 'repair'));
});

app.get('/api/archive/play/:key', (req, res) => {
  const media = archive.media(catalog.get(param(req, 'key')));
  if (!media) return void res.status(404).json({ error: 'this title has no archived rendition to play' });
  res.redirect(302, media.url);
});

/* --------------------- scheduled verification --------------------- */

/**
 * The scheduled check: when it last ran, when it runs next, what it found, and
 * how much of the archive has a verdict at all.
 *
 * `totals.failing` is the number to watch — a weekly sweep keeps it honest, and
 * the Library's own rows name the titles behind it.
 */
app.get('/api/archive/check', (_req, res) => {
  res.json(checkSchedule.stateView());
});

app.put('/api/archive/check', (req, res) => {
  try {
    res.json(checkSchedule.updateConfig((req.body ?? {}) as Record<string, unknown>));
  } catch (error) {
    if (error instanceof CheckScheduleError) return void res.status(400).json({ error: error.message });
    throw error;
  }
});

/** One sweep now, whatever the schedule says. */
app.post('/api/archive/check/run', (_req, res) => {
  res.json(checkSchedule.runNow());
});

app.post('/api/archive/check/log/clear', (_req, res) => {
  res.json(checkSchedule.clearLog());
});

/* ------------------------- subtitle backfill ------------------------- */

/** Which published titles are still missing a target language — no work done. */
app.get('/api/subtitles/backfill', (_req, res) => {
  res.json(backfill.preview());
});

/**
 * Fill them in, a batch at a time.
 *
 * `keys` narrows it to what the operator picked; `limit` bounds the batch, because
 * every title inside it costs a fetch, a translation and a caption upload. What a
 * batch does not reach is still missing afterwards, and the next request picks it
 * up.
 */
app.post('/api/subtitles/backfill', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit ?? 25)) || 25));
  const report = await backfill.run({ ...(keys.length ? { keys } : {}), limit });
  res.json(report);
}));

/* ---------------------------- autopilot ---------------------------- */

app.get('/api/autopilot', (_req, res) => {
  res.json(autopilot.stateView());
});

app.put('/api/autopilot', (req, res) => {
  try {
    res.json(autopilot.updateConfig((req.body ?? {}) as Record<string, unknown>));
  } catch (error) {
    if (error instanceof AutopilotError) return void res.status(400).json({ error: error.message });
    throw error;
  }
});

/** One cycle right now, whatever the schedule says. */
app.post('/api/autopilot/run', handle(async (_req, res) => {
  const report = await autopilot.runCycle();
  res.json({ report, state: autopilot.stateView() });
}));

app.post('/api/autopilot/reset', (_req, res) => {
  res.json(autopilot.reset());
});

app.post('/api/autopilot/log/clear', (_req, res) => {
  res.json(autopilot.clearLog());
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

/* ------------------------------ static ----------------------------- */

app.use(express.static(config.publicDir, { index: 'index.html' }));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof TmdbError || error instanceof BunnyError) {
    fail(res, error);
    return;
  }
  // A body the framework refused (an oversized watermark, malformed JSON) is
  // the caller's mistake, not a crash, so its own status is the honest answer.
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
  const code = typeof status === 'number' ? status : Number((error as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isFinite(code) && code >= 400 && code < 500) {
    res.status(code).json({ error: describeError(error) });
    return;
  }
  console.error('[dashboard] unhandled error:', error);
  res.status(500).json({ error: describeError(error) });
});

jobs.start();
watcher.start();
// The scheduler is always up; a cycle only runs while the autopilot is enabled.
autopilot.start();
// The verification schedule too: it only checks while it is switched on and R2
// is configured, and a tick is a clock read when it is not.
checkSchedule.start();
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!config.dashboardPassword && !loopback) {
  console.warn(
    `[dashboard] WARNING: listening on ${config.host} with no login — anyone who reaches this port controls your Bunny account. Set DASHBOARD_USER/DASHBOARD_PASSWORD.`,
  );
}
const server = app.listen(config.port, config.host, () => {
  const mode = config.mock ? 'MOCK providers — no real TMDB or Bunny calls' : 'live providers';
  console.log(`[dashboard] listening on http://${config.host}:${config.port} (${mode})`);
  console.log(
    config.dashboardPassword
      ? `[dashboard] login required (user ${config.dashboardUser ?? 'index'})`
      : '[dashboard] no login configured (set DASHBOARD_PASSWORD before exposing this port)',
  );
  console.log(`[dashboard] data directory: ${config.dataDir}`);
});

function shutdown(): void {
  jobs.stop();
  autopilot.stop();
  checkSchedule.stop();
  autoRepair.stop();
  archive.stop();
  store.flush();
  watcher.stop();
  tunnel.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
