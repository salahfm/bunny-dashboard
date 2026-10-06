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
import { ArchiveService } from './archive';
import { authGate } from './auth';
import { SubtitleAutoRepair, SubtitleBackfill, missingTargets } from './backfill';
import { Autopilot, AutopilotError } from './autopilot';
import { DEFAULT_MAX_BULK_JOBS, planBulk, planShow, queuedKeys, withoutQueued, type BulkOptions, type BulkPlan } from './bulk';
import { BunnyClient, BunnyError } from './bunny';
import { Catalog, type CatalogEntry } from './catalog';
import { MAX_UPLOAD_BYTES, loadConfig } from './config';
import { decryptSecret, encryptSecret, loadOrCreateSecret, maskSecret } from './crypto';
import { runDiagnostics } from './diagnostics';
import { JobService, jobTitle, sourceNameFromUrl } from './jobs';
import { HostGuard } from './hostguard';
import { DEFAULT_MIN_HEIGHT, previewScrape } from './stream';
import { configureScraper, providerCatalog, targetFromEmbedUrl } from './providers';
import { queueStats } from './queue';
import { R2Client } from './r2';
import { RelayHub } from './relay';
import { Store, type Job, type JobChangeKind, type JobSource, type JobTarget } from './store';
import { TmdbClient, TmdbError, lookupTmdb } from './tmdb';
import { DEEPL_WEB_ENDPOINT } from './translate';
import { TunnelManager } from './tunnel';
import { FolderWatcher } from './watch';

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

function accountView(account: { id: string; name: string; libraryId: string; apiKeyEnc: string; pullZoneHost?: string; enabled: boolean; createdAt: string; updatedAt: string }) {
  let masked: string | null = '••••';
  try {
    masked = maskSecret(decryptSecret(secret, account.apiKeyEnc));
  } catch {
    /* key cannot be read back; still show a mask */
  }
  return {
    id: account.id,
    name: account.name,
    libraryId: account.libraryId,
    pullZoneHost: account.pullZoneHost ?? null,
    enabled: account.enabled,
    apiKeyMasked: masked,
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
      auto: store.settings.archiveToR2 !== false,
    },
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

app.post('/api/accounts', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const libraryId = typeof body.libraryId === 'string' ? body.libraryId.trim() : String(body.libraryId ?? '').trim();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const pullZoneHost = typeof body.pullZoneHost === 'string' ? body.pullZoneHost.trim() : '';
  if (!name) return void res.status(400).json({ error: 'give the account a name' });
  if (!libraryId) return void res.status(400).json({ error: 'the Stream library ID is required' });
  if (!apiKey) return void res.status(400).json({ error: 'the Stream library API key is required' });
  if (store.accounts.length >= store.settings.maxAccounts) {
    return void res.status(400).json({ error: `account limit reached (${store.settings.maxAccounts})` });
  }
  const account = store.addAccount({
    name,
    libraryId,
    apiKeyEnc: encryptSecret(secret, apiKey),
    ...(pullZoneHost ? { pullZoneHost } : {}),
  });
  res.status(201).json({ account: accountView(account) });
});

app.patch('/api/accounts/:id', (req, res) => {
  const account = store.account(req.params.id);
  if (!account) return void res.status(404).json({ error: 'account not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { name?: string; libraryId?: string; apiKeyEnc?: string; pullZoneHost?: string; enabled?: boolean } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.libraryId === 'string' && body.libraryId.trim()) patch.libraryId = body.libraryId.trim();
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKeyEnc = encryptSecret(secret, body.apiKey.trim());
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

  // `retry` tells the browser how long to wait before reconnecting on its own.
  write('retry: 3000\n\n');
  send('hello', { at: new Date().toISOString(), stats: currentStats(), catalog: catalog.size });

  // One pending entry per job, so a burst of progress ticks collapses to the
  // latest state of each row rather than a burst of messages.
  const pending = new Map<string, { kind: JobChangeKind; job: Job }>();
  let flushTimer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    flushTimer = undefined;
    if (pending.size > 0) {
      const deltas = [...pending.values()].map((entry) => ({ kind: entry.kind, job: jobSummaryView(entry.job) }));
      pending.clear();
      send('jobs', { jobs: deltas });
    }
    pushStats();
    pushCatalog();
  };

  const unsubscribe = store.onJobChange((job, kind) => {
    pending.set(job.id, { kind, job });
    if (!flushTimer) {
      flushTimer = setTimeout(flush, LIVE_FLUSH_MS);
      flushTimer.unref?.();
    }
  });

  const heartbeat = setInterval(() => write(': ping\n\n'), LIVE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = (): void => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
    unsubscribe();
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

/** Which published titles still have a Bunny copy waiting to be archived. */
app.get('/api/archive', (_req, res) => {
  res.json(archive.preview());
});

/**
 * Archive now: the picked titles, or the oldest candidates when none were
 * picked. One at a time, because every title here is a multi-gigabyte download.
 */
app.post('/api/archive', handle(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string') : [];
  const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit ?? 10)) || 10));
  res.json(await archive.archiveKeys(keys, limit));
}));

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
  console.error('[dashboard] unhandled error:', error);
  res.status(500).json({ error: describeError(error) });
});

jobs.start();
watcher.start();
// The scheduler is always up; a cycle only runs while the autopilot is enabled.
autopilot.start();
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
