/**
 * Per-host politeness for the scraper.
 *
 * Why it exists: the scrape asks third-party pages and APIs for a source, and a
 * dashboard queueing a whole top-rated list asks them a great many times. Hammer
 * a host and it answers 403/429 — or a bot challenge — and then it keeps
 * answering that way, which is the difference between "this host is down" and
 * "we are blocked from this host". This guard keeps the two apart:
 *
 *   - requests to one host are serialised with a minimum gap between them, so a
 *     sweep cannot fire a burst at a single host;
 *   - a 403, 429, 5xx or a bot-challenge body puts the host in *cooldown*, and a
 *     `Retry-After` is honoured when the host sends one;
 *   - while a host is cooling down every request to it fails fast with a clear
 *     reason, so the sweep moves on to the next host instead of burning its
 *     timeout on one that will refuse.
 *
 * The state lives in memory only: a cooldown is about right now, and a restart
 * is itself a fresh chance.
 */

export interface HostGuardOptions {
  /** Smallest gap between two requests to the same host. */
  minIntervalMs?: number;
  /** First cooldown after a refusal, before any host signal is honoured. */
  baseCooldownMs?: number;
  /** Ceiling for an escalating cooldown. */
  maxCooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Log line per notable event (cooldown start, recovery). */
  log?: (message: string) => void;
}

/** A refusal: the host is telling us to go away, not failing. */
export interface HostCooldown {
  host: string;
  reason: string;
  until: number;
  failures: number;
}

export const DEFAULT_MIN_INTERVAL_MS = 350;
export const DEFAULT_BASE_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_COOLDOWN_MS = 30 * 60_000;

/** Statuses that mean "stop talking to me": blocked, throttled, or fell over. */
export function isBlockingStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 503;
}

/** Bodies that are a bot wall rather than the page that was asked for. */
export function looksLikeChallenge(body: string): boolean {
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('just a moment') ||
    head.includes('cf-chl') ||
    head.includes('cf_chl') ||
    head.includes('challenge-platform') ||
    head.includes('chl_page') ||
    head.includes('attention required') ||
    head.includes('enable javascript and cookies to continue') ||
    head.includes('ddos-guard') ||
    head.includes('checking your browser')
  );
}

export function retryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, DEFAULT_MAX_COOLDOWN_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, DEFAULT_MAX_COOLDOWN_MS));
  return undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export class HostGuard {
  private minIntervalMs: number;
  private baseCooldownMs: number;
  private maxCooldownMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private log: ((message: string) => void) | undefined;
  /** Serialises the requests sent to one host. */
  private chain = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private cooldowns = new Map<string, HostCooldown>();
  private failures = new Map<string, number>();

  constructor(options: HostGuardOptions = {}) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.baseCooldownMs = Math.max(1_000, options.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.log = options.log;
  }

  /** The active cooldown for a host, if any (expired ones are cleared as seen). */
  cooling(host: string): HostCooldown | undefined {
    const entry = this.cooldowns.get(host);
    if (!entry) return undefined;
    if (entry.until <= this.now()) {
      this.cooldowns.delete(host);
      return undefined;
    }
    return entry;
  }

  /**
   * Every host currently serving a cooldown, soonest to recover first. Ties are
   * broken by host name so the order is deterministic for a given set of hosts
   * (several can be cooled at the same instant by one sweep).
   */
  snapshot(): HostCooldown[] {
    for (const host of [...this.cooldowns.keys()]) this.cooling(host);
    return [...this.cooldowns.values()].sort((a, b) => a.until - b.until || a.host.localeCompare(b.host));
  }

  /**
   * Runs one request to `host`, waiting for its turn. Serialised per host and
   * paced by `minIntervalMs`, so a sweep of several hosts stays parallel while
   * one host is never hit in a burst.
   */
  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = previous.then(() => gate);
    this.chain.set(host, mine);

    await previous;
    try {
      const since = this.now() - (this.lastStart.get(host) ?? 0);
      const wait = this.minIntervalMs - since;
      if (wait > 0) await this.sleep(wait);
      this.lastStart.set(host, this.now());
      return await task();
    } finally {
      release();
      // Drop the chain entry once nothing else is queued behind it.
      if (this.chain.get(host) === mine) this.chain.delete(host);
    }
  }

  /** Records a response so a refusal can cool the host down. */
  observe(host: string, status: number, headers?: Headers): HostCooldown | undefined {
    if (!isBlockingStatus(status)) {
      if (status < 500) this.failures.delete(host);
      return undefined;
    }
    return this.penalize(host, `HTTP ${status}`, retryAfterMs(headers, this.now()));
  }

  /**
   * Puts a host on ice. The first refusal waits `baseCooldownMs` (or the host's
   * own `Retry-After`), and a host that keeps refusing waits longer each time so
   * a stuck source cannot be retried into a permanent ban.
   */
  penalize(host: string, reason: string, overrideMs?: number): HostCooldown {
    const failures = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, failures);
    const escalated = Math.min(this.maxCooldownMs, this.baseCooldownMs * 2 ** (failures - 1));
    const duration = Math.max(overrideMs ?? 0, escalated);
    const until = this.now() + duration;
    const entry: HostCooldown = { host, reason, until, failures };
    this.cooldowns.set(host, entry);
    this.log?.(`[hosts] cooling ${host} for ${Math.round(duration / 1000)}s after ${reason}`);
    return entry;
  }

  /** Forgets a host's history — used by the tests and by a manual "clear" call. */
  clear(host?: string): void {
    if (host) {
      this.cooldowns.delete(host);
      this.failures.delete(host);
      return;
    }
    this.cooldowns.clear();
    this.failures.clear();
  }
}
