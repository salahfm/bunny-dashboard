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
import { authGate } from './auth';
import { DEFAULT_MAX_BULK_JOBS, planBulk, planShow, queuedKeys, withoutQueued, type BulkOptions, type BulkPlan } from './bulk';
import { BunnyClient, BunnyError } from './bunny';
import { MAX_UPLOAD_BYTES, loadConfig } from './config';
import { decryptSecret, encryptSecret, loadOrCreateSecret, maskSecret } from './crypto';
import { runDiagnostics } from './diagnostics';
import { JobService, sourceNameFromUrl } from './jobs';
import { DEFAULT_MIN_HEIGHT, previewScrape } from './stream';
import { providerCatalog, targetFromEmbedUrl } from './providers';
import { queueStats } from './queue';
import { RelayHub } from './relay';
import { Store, type Job, type JobSource, type JobTarget } from './store';
import { TmdbClient, TmdbError, lookupTmdb } from './tmdb';
import { TunnelManager } from './tunnel';
import { FolderWatcher } from './watch';

const config = loadConfig();
const secret = loadOrCreateSecret(config.secretPath);
const store = new Store(config);

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

const jobs = new JobService({ store, config, clientFactory: clientForAccount, relay, tunnel });
jobs.recover();

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
  return { ...job, accountName: account?.name ?? null };
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
    },
    limits: { maxAccounts: 30, perAccountConcurrency: 10, maxUploadBytes: MAX_UPLOAD_BYTES },
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
  res.json({ providers: providerCatalog(), minHeight: DEFAULT_MIN_HEIGHT });
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
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : url ? sourceNameFromUrl(url) : jobTitleOf(target);

  const job = jobs.createStreamJob(target, {
    mode,
    ...(url ? { input: url } : {}),
    ...(only && only.length ? { only } : {}),
    minHeight: Number.isFinite(minHeight) && minHeight > 0 ? minHeight : DEFAULT_MIN_HEIGHT,
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
  const minHeight = Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_MIN_HEIGHT;
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
    jobs: filtered.slice(0, limit).map(jobView),
    stats: queueStats(store.jobs, store.accounts, store.settings.perAccountConcurrency),
  });
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

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

/** The job title as the pipeline would write it (kept beside `jobTitle` in jobs.ts). */
function jobTitleOf(target: JobTarget): string {
  if (target.kind === 'movie') return target.year ? `${target.title} (${target.year})` : target.title;
  const season = String(target.season ?? 1).padStart(2, '0');
  const episode = String(target.episode ?? 1).padStart(2, '0');
  return `${target.title} S${season}E${episode}`;
}

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
  watcher.stop();
  tunnel.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
