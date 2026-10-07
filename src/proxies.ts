/**
 * The scrape layer's proxy pool.
 *
 * Why it exists: the hosts this dashboard scrapes eventually answer 403/429 — or
 * a bot wall — to the machine that asks them too often, and once that starts it
 * does not stop, because the block is on the *address*, not on the request. A
 * sweep that used to resolve twenty sources dies with `HTTP 403` and no source
 * for any title. So every scrape request leaves through a pool of proxy exits and
 * the pool spreads the requests, which is what makes the block go away.
 *
 * Why it is only the scrape layer: these exits are metered (the plan behind this
 * list allows 1 GB). A page, an API answer or a subtitle file is a few tens of
 * kilobytes; a video is gigabytes. So the download half of the pipeline — the
 * playlist, the segments, the Bunny upload, the R2 copy — never touches a proxy
 * and stays on this machine's own connection, where a byte is free. The one
 * exception is deliberate: the exit test in the dashboard, which is a few
 * hundred bytes per exit and is what tells the operator which exits are alive.
 *
 * What the pool does with a refusal, in one line: an exit that the *site* blocked
 * is put aside for a while and the next request goes out through another exit; an
 * exit that the *proxy* refused (no bandwidth left, wrong credentials, a dead
 * socket) is put aside for much longer. When every exit is aside the scraper goes
 * back to talking to the host directly, which is exactly what it did before this
 * pool existed.
 */

import type { Dispatcher, ProxyAgent } from 'undici';

/* ------------------------------------------------------------------ */
/* The exits                                                           */
/* ------------------------------------------------------------------ */

export interface ProxyEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
  /** `user@host:port` — how this exit is named in a log line or on the dashboard. */
  label: string;
  /** `http://user:pass@host:port` — what the transport is handed. */
  url: string;
}

function buildEndpoint(host: string, port: number, username: string, password: string): ProxyEndpoint {
  return {
    host,
    port,
    username,
    password,
    label: `${username}@${host}:${port}`,
    url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
  };
}

function validPort(value: string | number): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * One proxy, in any of the shapes a provider hands them out:
 *
 *   `host:port:user:pass`      the export format (what the built-in list is)
 *   `user:pass@host:port`      the same thing, the way a URL writes it
 *   `http://user:pass@host:port`
 *
 * A blank line, a `#` comment or anything unparseable is skipped rather than
 * guessed at: a half-read proxy line would send requests somewhere unintended.
 */
export function parseProxyEntry(raw: string): ProxyEndpoint | undefined {
  const text = (raw ?? '').trim();
  if (!text || text.startsWith('#')) return undefined;

  const at = text.lastIndexOf('@');
  if (at > 0) {
    const credentials = text.slice(0, at).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const address = text.slice(at + 1);
    const split = credentials.indexOf(':');
    if (split <= 0) return undefined;
    const username = decodeURIComponent(credentials.slice(0, split));
    const password = decodeURIComponent(credentials.slice(split + 1));
    const colon = address.lastIndexOf(':');
    if (colon <= 0) return undefined;
    const host = address.slice(0, colon).replace(/^\[|\]$/g, '');
    const port = validPort(address.slice(colon + 1));
    if (!host || !port || !username || !password) return undefined;
    return buildEndpoint(host, port, username, password);
  }

  const parts = text.split(':');
  if (parts.length !== 4) return undefined;
  const [host, rawPort, username, password] = parts.map((part) => part.trim());
  const port = validPort(rawPort ?? '');
  if (!host || !port || !username || !password) return undefined;
  return buildEndpoint(host, port, username, password);
}

/** A whole list, in one string (comma, semicolon or newline separated) or an array. */
export function parseProxyList(raw: string | string[] | undefined): ProxyEndpoint[] {
  if (!raw) return [];
  const chunks = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
  const out: ProxyEndpoint[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const entry = parseProxyEntry(chunk);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

/**
 * The exits this dashboard ships with.
 *
 * Nine credential sets over the same ten addresses: the live ones are usable
 * immediately, and a set whose plan has run out of bandwidth answers 402 to
 * every request — that is what the health below is for, and it is why the whole
 * list is kept rather than the one set that happened to work the day it was
 * pasted in. `SCRAPER_PROXIES` replaces this list without a code change.
 */
export const BUILT_IN_PROXIES: string[] = [
  // set 0
  '31.59.20.176:6754:sydblqor:9hgn1ml1w4kp',
  '45.38.107.97:6014:sydblqor:9hgn1ml1w4kp',
  '64.137.96.74:6641:sydblqor:9hgn1ml1w4kp',
  '198.23.243.226:6361:sydblqor:9hgn1ml1w4kp',
  '38.154.185.97:6370:sydblqor:9hgn1ml1w4kp',
  '84.247.60.125:6095:sydblqor:9hgn1ml1w4kp',
  '142.111.67.146:5611:sydblqor:9hgn1ml1w4kp',
  '191.96.254.138:6185:sydblqor:9hgn1ml1w4kp',
  '31.58.9.4:6077:sydblqor:9hgn1ml1w4kp',
  '198.46.161.42:5092:sydblqor:9hgn1ml1w4kp',
  // set 1
  '31.59.20.176:6754:qmlaqiks:133gbhj0l6tc',
  '45.38.107.97:6014:qmlaqiks:133gbhj0l6tc',
  '64.137.96.74:6641:qmlaqiks:133gbhj0l6tc',
  '198.23.243.226:6361:qmlaqiks:133gbhj0l6tc',
  '38.154.185.97:6370:qmlaqiks:133gbhj0l6tc',
  '84.247.60.125:6095:qmlaqiks:133gbhj0l6tc',
  '142.111.67.146:5611:qmlaqiks:133gbhj0l6tc',
  '191.96.254.138:6185:qmlaqiks:133gbhj0l6tc',
  '31.58.9.4:6077:qmlaqiks:133gbhj0l6tc',
  '198.46.161.42:5092:qmlaqiks:133gbhj0l6tc',
  // set 2
  '31.59.20.176:6754:zhumbtnt:bbxy1qsc0wlf',
  '45.38.107.97:6014:zhumbtnt:bbxy1qsc0wlf',
  '64.137.96.74:6641:zhumbtnt:bbxy1qsc0wlf',
  '198.23.243.226:6361:zhumbtnt:bbxy1qsc0wlf',
  '38.154.185.97:6370:zhumbtnt:bbxy1qsc0wlf',
  '84.247.60.125:6095:zhumbtnt:bbxy1qsc0wlf',
  '142.111.67.146:5611:zhumbtnt:bbxy1qsc0wlf',
  '191.96.254.138:6185:zhumbtnt:bbxy1qsc0wlf',
  '31.58.9.4:6077:zhumbtnt:bbxy1qsc0wlf',
  '198.46.161.42:5092:zhumbtnt:bbxy1qsc0wlf',
  // set 3
  '31.59.20.176:6754:dyziydba:yxw5thetz7bl',
  '45.38.107.97:6014:dyziydba:yxw5thetz7bl',
  '64.137.96.74:6641:dyziydba:yxw5thetz7bl',
  '198.23.243.226:6361:dyziydba:yxw5thetz7bl',
  '38.154.185.97:6370:dyziydba:yxw5thetz7bl',
  '84.247.60.125:6095:dyziydba:yxw5thetz7bl',
  '142.111.67.146:5611:dyziydba:yxw5thetz7bl',
  '191.96.254.138:6185:dyziydba:yxw5thetz7bl',
  '31.58.9.4:6077:dyziydba:yxw5thetz7bl',
  '198.46.161.42:5092:dyziydba:yxw5thetz7bl',
  // set 4
  '31.59.20.176:6754:casmzoov:ga61eov8wsfj',
  '45.38.107.97:6014:casmzoov:ga61eov8wsfj',
  '64.137.96.74:6641:casmzoov:ga61eov8wsfj',
  '198.23.243.226:6361:casmzoov:ga61eov8wsfj',
  '38.154.185.97:6370:casmzoov:ga61eov8wsfj',
  '84.247.60.125:6095:casmzoov:ga61eov8wsfj',
  '142.111.67.146:5611:casmzoov:ga61eov8wsfj',
  '191.96.254.138:6185:casmzoov:ga61eov8wsfj',
  '31.58.9.4:6077:casmzoov:ga61eov8wsfj',
  '198.46.161.42:5092:casmzoov:ga61eov8wsfj',
  // set 5
  '31.59.20.176:6754:oqnugthq:vl6gyux0wq0d',
  '45.38.107.97:6014:oqnugthq:vl6gyux0wq0d',
  '64.137.96.74:6641:oqnugthq:vl6gyux0wq0d',
  '198.23.243.226:6361:oqnugthq:vl6gyux0wq0d',
  '38.154.185.97:6370:oqnugthq:vl6gyux0wq0d',
  '84.247.60.125:6095:oqnugthq:vl6gyux0wq0d',
  '142.111.67.146:5611:oqnugthq:vl6gyux0wq0d',
  '191.96.254.138:6185:oqnugthq:vl6gyux0wq0d',
  '31.58.9.4:6077:oqnugthq:vl6gyux0wq0d',
  '198.46.161.42:5092:oqnugthq:vl6gyux0wq0d',
  // set 6
  '31.59.20.176:6754:salah1949f:salah1949',
  '45.38.107.97:6014:salah1949f:salah1949',
  '64.137.96.74:6641:salah1949f:salah1949',
  '198.23.243.226:6361:salah1949f:salah1949',
  '38.154.185.97:6370:salah1949f:salah1949',
  '84.247.60.125:6095:salah1949f:salah1949',
  '142.111.67.146:5611:salah1949f:salah1949',
  '191.96.254.138:6185:salah1949f:salah1949',
  '31.58.9.4:6077:salah1949f:salah1949',
  '198.46.161.42:5092:salah1949f:salah1949',
  // set 7
  '31.59.20.176:6754:fyiquebm:salah1949',
  '45.38.107.97:6014:fyiquebm:salah1949',
  '64.137.96.74:6641:fyiquebm:salah1949',
  '198.23.243.226:6361:fyiquebm:salah1949',
  '38.154.185.97:6370:fyiquebm:salah1949',
  '84.247.60.125:6095:fyiquebm:salah1949',
  '142.111.67.146:5611:fyiquebm:salah1949',
  '191.96.254.138:6185:fyiquebm:salah1949',
  '31.58.9.4:6077:fyiquebm:salah1949',
  '198.46.161.42:5092:fyiquebm:salah1949',
  // set 8
  '31.59.20.176:6754:vqflsonm:q4ygsi8ercbm',
  '45.38.107.97:6014:vqflsonm:q4ygsi8ercbm',
  '64.137.96.74:6641:vqflsonm:q4ygsi8ercbm',
  '198.23.243.226:6361:vqflsonm:q4ygsi8ercbm',
  '38.154.185.97:6370:vqflsonm:q4ygsi8ercbm',
  '84.247.60.125:6095:vqflsonm:q4ygsi8ercbm',
  '142.111.67.146:5611:vqflsonm:q4ygsi8ercbm',
  '191.96.254.138:6185:vqflsonm:q4ygsi8ercbm',
  '31.58.9.4:6077:vqflsonm:q4ygsi8ercbm',
  '198.46.161.42:5092:vqflsonm:q4ygsi8ercbm',
];

/** The built-in list, parsed. */
export function builtInProxies(): ProxyEndpoint[] {
  return parseProxyList(BUILT_IN_PROXIES);
}

/* ------------------------------------------------------------------ */
/* The pool                                                            */
/* ------------------------------------------------------------------ */

/** What one request through one exit did. */
export type ProxyVerdict =
  /** It answered. */
  | 'ok'
  /** The *host* refused this exit — 401/403/429/503, or a bot wall. */
  | 'blocked'
  /** The *proxy* refused us — no bandwidth left (402), bad credentials (407). */
  | 'unusable'
  /** The connection died before an answer. */
  | 'failed';

export type ProxyState = 'fresh' | 'working' | 'blocked' | 'unusable';

export interface ProxyHealth {
  label: string;
  state: ProxyState;
  requests: number;
  failures: number;
  bytes: number;
  lastStatus?: number;
  lastError?: string;
  /** When the exit becomes usable again (blocked or unusable). */
  until?: number;
  lastUsedAt?: number;
}

export interface ProxyPoolStats {
  total: number;
  ready: number;
  blocked: number;
  unusable: number;
  requests: number;
  bytes: number;
  budgetBytes: number;
  overBudget: boolean;
  /** Everything that is not quietly working: the rows a dashboard shows. */
  notable: ProxyHealth[];
}

export interface ProxyPoolOptions {
  /** How long an exit sits out after the host refused it. */
  blockedCooldownMs?: number;
  /** How long an exit sits out after the proxy itself refused it. */
  unusableCooldownMs?: number;
  /** How long one dead connection puts an exit aside. */
  failedCooldownMs?: number;
  /** Dead connections in a row before the exit is treated as unusable. */
  maxFailed?: number;
  /** What the plan allows, in bytes. Only ever used to warn. */
  budgetBytes?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export const DEFAULT_BLOCKED_COOLDOWN_MS = 60_000;
export const DEFAULT_UNUSABLE_COOLDOWN_MS = 6 * 60 * 60_000;
export const DEFAULT_FAILED_COOLDOWN_MS = 30_000;
export const DEFAULT_MAX_FAILED = 3;

interface ProxyAccount {
  endpoint: ProxyEndpoint;
  requests: number;
  failures: number;
  bytes: number;
  lastStatus?: number;
  lastError?: string;
  blockedUntil: number;
  unusableUntil: number;
  failed: number;
  lastUsedAt: number;
}

/**
 * The exits, their health, and whose turn it is.
 *
 * Rotation is least-recently-used among the exits that are not sitting out, so a
 * run of requests spreads across the whole list instead of hammering one exit.
 * An exit is only ever set aside for a *stated* reason — the site blocked it, the
 * proxy refused it, or the connection died — and every reason has an expiry, so a
 * pool that was fine an hour ago does not stay broken for the life of the process.
 */
export class ProxyPool {
  private accounts: ProxyAccount[] = [];
  private byLabel = new Map<string, ProxyAccount>();
  private blockedCooldownMs: number;
  private unusableCooldownMs: number;
  private failedCooldownMs: number;
  private maxFailed: number;
  private budgetBytes: number;
  private now: () => number;
  private log: ((message: string) => void) | undefined;
  private budgetWarned = false;
  private requests = 0;
  private bytes = 0;

  constructor(endpoints: ProxyEndpoint[], options: ProxyPoolOptions = {}) {
    this.blockedCooldownMs = Math.max(1_000, options.blockedCooldownMs ?? DEFAULT_BLOCKED_COOLDOWN_MS);
    this.unusableCooldownMs = Math.max(this.blockedCooldownMs, options.unusableCooldownMs ?? DEFAULT_UNUSABLE_COOLDOWN_MS);
    this.failedCooldownMs = Math.max(0, options.failedCooldownMs ?? DEFAULT_FAILED_COOLDOWN_MS);
    this.maxFailed = Math.max(1, options.maxFailed ?? DEFAULT_MAX_FAILED);
    this.budgetBytes = Math.max(0, options.budgetBytes ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
    for (const endpoint of endpoints) {
      // Two sets can share an address; the label carries the user so they stay
      // apart on the dashboard and in the log.
      if (this.byLabel.has(endpoint.label)) continue;
      const account: ProxyAccount = {
        endpoint,
        requests: 0,
        failures: 0,
        bytes: 0,
        blockedUntil: 0,
        unusableUntil: 0,
        failed: 0,
        lastUsedAt: 0,
      };
      this.accounts.push(account);
      this.byLabel.set(endpoint.label, account);
    }
  }

  get size(): number {
    return this.accounts.length;
  }

  /** Every exit, in the order it was configured. */
  all(): ProxyEndpoint[] {
    return this.accounts.map((account) => account.endpoint);
  }

  private open(account: ProxyAccount): boolean {
    const now = this.now();
    return now >= account.blockedUntil && now >= account.unusableUntil;
  }

  /** How many exits can be used right now. */
  ready(): number {
    return this.accounts.filter((account) => this.open(account)).length;
  }

  /**
   * The next exit to use: the one that has failed least, and among those the one
   * that has waited longest. `except` skips the exits this request already tried,
   * which is what makes a rotation inside one request move forward.
   */
  pick(except?: Set<string>): ProxyEndpoint | undefined {
    const candidates = this.accounts.filter(
      (account) => this.open(account) && !(except?.has(account.endpoint.label) ?? false),
    );
    if (!candidates.length) return undefined;
    candidates.sort(
      (a, b) => a.failures - b.failures || a.lastUsedAt - b.lastUsedAt || a.endpoint.label.localeCompare(b.endpoint.label),
    );
    const chosen = candidates[0]!;
    chosen.lastUsedAt = this.now();
    return chosen.endpoint;
  }

  /** Records what one request through one exit did. */
  report(endpoint: ProxyEndpoint, verdict: ProxyVerdict, detail?: string): void {
    const account = this.byLabel.get(endpoint.label);
    if (!account) return;
    const now = this.now();
    if (verdict === 'ok') {
      account.failures = 0;
      account.failed = 0;
      account.blockedUntil = 0;
      account.unusableUntil = 0;
      const status = /\b(\d{3})\b/.exec(detail ?? '')?.[1];
      if (status) account.lastStatus = Number(status);
      return;
    }

    account.failures += 1;
    if (verdict === 'blocked') {
      // The exit works; the host does not like it. Wait longer each time it is
      // refused again, the same way the host cooldown escalates.
      const wait = Math.min(this.unusableCooldownMs, this.blockedCooldownMs * 2 ** (account.failures - 1));
      account.blockedUntil = now + wait;
      account.lastError = detail ?? 'the host refused it';
      this.log?.(`[scrape] ${endpoint.label} set aside for ${Math.round(wait / 1000)}s — ${account.lastError}`);
      return;
    }

    if (verdict === 'unusable') {
      account.unusableUntil = now + this.unusableCooldownMs;
      account.lastError = detail ?? 'the proxy refused the request';
      this.log?.(
        `[scrape] ${endpoint.label} is out of the pool for ${Math.round(this.unusableCooldownMs / 60_000)} min — ${account.lastError}`,
      );
      return;
    }

    account.failed += 1;
    account.lastError = detail ?? 'the connection failed';
    if (account.failed >= this.maxFailed) {
      account.unusableUntil = now + this.unusableCooldownMs;
      this.log?.(`[scrape] ${endpoint.label} is out of the pool — ${account.failed} failed connection(s) in a row`);
      return;
    }
    account.blockedUntil = now + this.failedCooldownMs;
    this.log?.(`[scrape] ${endpoint.label} set aside for ${Math.round(this.failedCooldownMs / 1000)}s — ${account.lastError}`);
  }

  /** Counts the bytes a response through this exit actually delivered. */
  count(endpoint: ProxyEndpoint, bytes: number): void {
    const account = this.byLabel.get(endpoint.label);
    if (!account) return;
    account.bytes += bytes;
    this.bytes += bytes;
    if (this.budgetBytes && !this.budgetWarned && this.bytes > this.budgetBytes) {
      this.budgetWarned = true;
      this.log?.(
        `[scrape] the proxy plan's ${Math.round(this.budgetBytes / 1_048_576)} MB is spent — ` +
          'the scrape layer keeps using the exits until they stop answering (SCRAPER_PROXY_BUDGET_MB)',
      );
    }
  }

  /**
   * Counts one request. Separate from [report] because a request that is refused,
   * aborted or never read is still a request the plan was charged for.
   */
  touch(endpoint: ProxyEndpoint): void {
    const account = this.byLabel.get(endpoint.label);
    if (!account) return;
    account.requests += 1;
    this.requests += 1;
  }

  private health(account: ProxyAccount): ProxyHealth {
    const now = this.now();
    const until = Math.max(account.blockedUntil, account.unusableUntil);
    const state: ProxyState = now < account.unusableUntil
      ? 'unusable'
      : now < account.blockedUntil
        ? 'blocked'
        : account.requests > 0
          ? 'working'
          : 'fresh';
    return {
      label: account.endpoint.label,
      state,
      requests: account.requests,
      failures: account.failures,
      bytes: account.bytes,
      ...(account.lastStatus !== undefined ? { lastStatus: account.lastStatus } : {}),
      ...(account.lastError ? { lastError: account.lastError } : {}),
      ...(until > now ? { until } : {}),
      ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
    };
  }

  stats(): ProxyPoolStats {
    const now = this.now();
    let blocked = 0;
    let unusable = 0;
    let ready = 0;
    const notable: ProxyHealth[] = [];
    for (const account of this.accounts) {
      const openNow = account.blockedUntil <= now && account.unusableUntil <= now;
      if (openNow) ready += 1;
      else if (account.unusableUntil > now) unusable += 1;
      else blocked += 1;
      const health = this.health(account);
      if (health.state !== 'fresh' && health.state !== 'working') notable.push(health);
    }
    notable.sort((a, b) => (b.until ?? 0) - (a.until ?? 0) || a.label.localeCompare(b.label));
    return {
      total: this.accounts.length,
      ready,
      blocked,
      unusable,
      requests: this.requests,
      bytes: this.bytes,
      budgetBytes: this.budgetBytes,
      overBudget: Boolean(this.budgetBytes) && this.bytes > this.budgetBytes,
      notable,
    };
  }

  /** Forgets every verdict — used by the exit test and by a manual reset. */
  clear(): void {
    for (const account of this.accounts) {
      account.failures = 0;
      account.failed = 0;
      account.blockedUntil = 0;
      account.unusableUntil = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* The transport                                                       */
/* ------------------------------------------------------------------ */

/**
 * One connection pool per exit, kept for the life of the process.
 *
 * A `ProxyAgent` holds the sockets through which the exit is reached; building one
 * per request would throw away the TLS session and the CONNECT tunnel every time,
 * which is most of the cost of a proxied request.
 */
const agents = new Map<string, ProxyAgent>();
let undici: typeof import('undici') | undefined;

/**
 * The transport library, loaded the first time an exit is actually used.
 *
 * Deliberately lazy, and deliberately *not* a top-level import: importing it is
 * not free — undici v8 puts something on a global symbol that Node's own `fetch`
 * then picks up, and a `content-length` header on a Buffer body (which the R2
 * client sends) starts failing with `invalid content-length header` in every
 * request in the process. That is a real bug this cost an afternoon to find, so
 * the fix is two-fold: the version is pinned to the 6.x line, and a process that
 * never uses a proxy never loads it at all.
 */
async function transport(): Promise<typeof import('undici')> {
  undici ??= await import('undici');
  return undici;
}

async function dispatcherFor(endpoint: ProxyEndpoint): Promise<Dispatcher> {
  const cached = agents.get(endpoint.url);
  if (cached) return cached;
  const { ProxyAgent: Agent } = await transport();
  const agent = new Agent({ uri: endpoint.url, connect: { timeout: 20_000 } });
  agents.set(endpoint.url, agent);
  return agent;
}

/** Closes every proxy connection — for a clean shutdown in a test rig. */
export async function closeDispatchers(): Promise<void> {
  const all = [...agents.values()];
  agents.clear();
  await Promise.all(all.map((agent) => agent.close().catch(() => undefined)));
}

interface ProxyFailure {
  /** The status the proxy itself answered with, when it said one. */
  status?: number;
  message: string;
}

/**
 * Why a proxied request threw, read out of the error chain undici builds.
 *
 * A proxy that refuses a `https://` target never gets to answer the request: it
 * answers the CONNECT, undici turns the non-2xx into an abort, and what surfaces
 * is `TypeError: fetch failed` with the real reason two causes down. A 402 there
 * means the plan's bandwidth is spent, and a 407 means the credentials are wrong
 * — both are "this exit cannot be used", not "the site is down".
 */
export function readProxyFailure(error: unknown): ProxyFailure {
  const messages: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node; depth += 1) {
    const value = node as { name?: string; message?: string; cause?: unknown };
    if (value.message) messages.push(value.message);
    node = value.cause;
  }
  const text = messages.join(' · ');
  const status = Number(/proxy response \((\d{3})\)/i.exec(text)?.[1] ?? Number.NaN);
  if (Number.isFinite(status)) return { status, message: `the proxy answered HTTP ${status}` };
  return { message: messages[0] ?? 'the connection failed' };
}

/** A status only a proxy sends: 407 needs credentials, 402 needs bandwidth. */
export function isProxyRefusal(status: number): boolean {
  return status === 402 || status === 407;
}

/** Wraps a response so the bytes that actually leave the exit are counted. */
export function countBytes(response: Response, onBytes: (bytes: number) => void): Response {
  const status = response.status;
  if (!response.body || status < 200 || status === 204 || status === 205 || status === 304) return response;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, { status, statusText: response.statusText, headers: response.headers });
}

async function throughProxy(endpoint: ProxyEndpoint, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const { fetch: undiciFetch } = await transport();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const dispatcher = await dispatcherFor(endpoint);
  const response = await undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher } as Parameters<
    typeof undiciFetch
  >[1]);
  return response as unknown as Response;
}

/**
 * A `fetch` that sends everything through the pool.
 *
 * Each call picks its own exit, so the caller's own retry policy spreads a
 * repeated attempt across different exits for free. An exit the *proxy* refuses
 * (402/407) is dropped and the request goes out through another one; when no exit
 * is left the request falls back to the direct connection, which is what the
 * scraper did before the pool existed. The optional `seen` callback reports which
 * exit actually answered, so a caller can rotate away from it deliberately.
 */
export function proxyFetcher(pool: ProxyPool, seen?: (endpoint: ProxyEndpoint) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const tried = new Set<string>();
    for (;;) {
      const endpoint = pool.pick(tried);
      if (!endpoint) break;
      tried.add(endpoint.label);
      seen?.(endpoint);
      pool.touch(endpoint);
      try {
        const response = await throughProxy(endpoint, input, init);
        if (isProxyRefusal(response.status)) {
          pool.report(endpoint, 'unusable', `HTTP ${response.status}`);
          continue;
        }
        pool.report(endpoint, 'ok', `HTTP ${response.status}`);
        return countBytes(response, (bytes) => pool.count(endpoint, bytes));
      } catch (error) {
        const failure = readProxyFailure(error);
        pool.report(endpoint, failure.status !== undefined && isProxyRefusal(failure.status) ? 'unusable' : 'failed', failure.message);
        throw error;
      }
    }
    return fetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

/* ------------------------------------------------------------------ */
/* The exit test                                                       */
/* ------------------------------------------------------------------ */

export interface ProxyTestResult {
  label: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  bytes: number;
}

export interface ProxyTestOptions {
  /** A tiny, neutral page: the question is whether the exit works, not what it says. */
  target?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** Which exits to test — the default is the ones that are not quietly working. */
  endpoints?: ProxyEndpoint[];
}

export const PROXY_TEST_TARGET = 'https://example.com/';

/**
 * Sends one tiny request through each exit and reports what came back.
 *
 * This is the answer to "why is scraping blocked?" that a job log cannot give: it
 * says which exits are alive, which the *plan* has run out of bandwidth for (402),
 * and which the credentials no longer work for (407) — the difference between "buy
 * more bandwidth" and "paste a fresh list". Bounded concurrency, because ten
 * exits answering at once is already brisk and ninety is a burst.
 */
export async function testExits(pool: ProxyPool, options: ProxyTestOptions = {}): Promise<ProxyTestResult[]> {
  const target = options.target ?? PROXY_TEST_TARGET;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 6));
  const endpoints = options.endpoints ?? pool.all();
  const results: ProxyTestResult[] = new Array(endpoints.length);

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const endpoint = endpoints[index];
      if (!endpoint) return;
      const started = Date.now();
      let bytes = 0;
      try {
        const response = await throughProxy(endpoint, target, {
          method: 'GET',
          headers: { accept: 'text/html,*/*' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        pool.touch(endpoint);
        await countBytes(response, (size) => {
          bytes += size;
        }).text();
        pool.count(endpoint, bytes);
        if (isProxyRefusal(response.status)) {
          pool.report(endpoint, 'unusable', `HTTP ${response.status}`);
          results[index] = { label: endpoint.label, ok: false, status: response.status, ms: Date.now() - started, bytes, error: `the proxy answered HTTP ${response.status}` };
        } else if (response.ok) {
          pool.report(endpoint, 'ok', `HTTP ${response.status}`);
          results[index] = { label: endpoint.label, ok: true, status: response.status, ms: Date.now() - started, bytes };
        } else {
          pool.report(endpoint, 'blocked', `HTTP ${response.status}`);
          results[index] = { label: endpoint.label, ok: false, status: response.status, ms: Date.now() - started, bytes, error: `the target answered HTTP ${response.status}` };
        }
      } catch (error) {
        const failure = readProxyFailure(error);
        pool.report(endpoint, failure.status !== undefined && isProxyRefusal(failure.status) ? 'unusable' : 'failed', failure.message);
        results[index] = { label: endpoint.label, ok: false, ms: Date.now() - started, bytes, error: failure.message };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, endpoints.length) }, () => worker()));
  return results.filter(Boolean);
}
