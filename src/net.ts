/**
 * The outbound fetch policy every control-plane call goes through.
 *
 * Why it exists: a single `fetch` against a host whose path is slow, flaky or
 * filtered does not fail cleanly — it hangs until the OS gives up, and the caller
 * sees Node's own `TypeError: fetch failed`, which says nothing about which host,
 * how long it waited, or what to do about it. That is exactly the shape of a
 * "Direct scraping" job that dies with `fetch failed` and no other clue.
 *
 * So: every attempt carries its own abort timer, retryable failures (a dead
 * connection, a timeout, 408/429/5xx) are retried with a little jittered backoff,
 * and the failure that finally surfaces names the host, the attempt count, the
 * time spent and the transport's own error code.
 */

export class NetworkError extends Error {
  /** The host (or `host:port`) the request was aimed at. */
  host: string;
  /** Timed out rather than refused/reset/failed. */
  timedOut: boolean;
  attempts: number;
  /** Any HTTP status the last attempt produced (retryable ones only). */
  status?: number;
  cause?: unknown;

  constructor(message: string, fields: { host: string; timedOut: boolean; attempts: number; status?: number; cause?: unknown }) {
    super(message);
    this.name = 'NetworkError';
    this.host = fields.host;
    this.timedOut = fields.timedOut;
    this.attempts = fields.attempts;
    this.cause = fields.cause;
    if (fields.status !== undefined) this.status = fields.status;
  }
}

export interface FetchPolicy {
  /** Per-attempt ceiling. */
  timeoutMs?: number;
  /** Extra attempts after the first (0 = one shot). */
  retries?: number;
  /** Base delay for the backoff; the real wait is jittered around it. */
  backoffMs?: number;
  /** A short label used in the error message, e.g. `Bunny API`. */
  what?: string;
  signal?: AbortSignal;
  /** The fetch to use (tests inject one; the default is the global fetch). */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_RETRIES = 3;

/** Statuses worth another attempt: the server asked for one, or fell over. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function jitter(base: number, attempt: number): number {
  const grow = base * 2 ** (attempt - 1);
  return Math.round(grow * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The transport's own codes, in the order they are worth naming. */
export function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const code = (cause as { code?: string } | undefined)?.code ?? (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function describeNetworkError(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  const code = errorCode(error);
  if (code) return code;
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `fetch` with a per-attempt timeout and retries.
 *
 * Only transport failures and retryable statuses are retried: a 401 from Bunny
 * is an answer (the key is wrong), and retrying it would just be noise. The
 * response is returned as-is when it is not retryable — the caller keeps its own
 * error handling for those, which is where the HTTP-specific messages live.
 */
export async function fetchWithPolicy(url: string, init: RequestInit = {}, policy: FetchPolicy = {}): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(policy.retries ?? DEFAULT_FETCH_RETRIES));
  const backoffMs = policy.backoffMs ?? 800;
  const host = hostOf(url);
  const what = policy.what ?? host;

  let lastError: unknown;
  let lastStatus: number | undefined;
  let timedOut = false;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (policy.signal?.aborted) throw new NetworkError(`${what}: cancelled`, { host, timedOut: false, attempts: attempt });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    policy.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await (policy.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
      if (!isRetryableStatus(response.status)) return response;
      lastStatus = response.status;
      lastError = undefined;
      // Drain the body so the socket is not held open by an unread response.
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      lastError = error;
      timedOut = controller.signal.aborted && !policy.signal?.aborted;
    } finally {
      clearTimeout(timer);
      policy.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (attempt <= retries) await sleep(jitter(backoffMs, attempt));
  }

  const parts: string[] = [];
  if (lastStatus !== undefined) parts.push(`HTTP ${lastStatus}`);
  else if (timedOut) parts.push(`no answer within ${Math.round(timeoutMs / 1000)}s`);
  const code = errorCode(lastError);
  if (code) parts.push(code);
  else if (lastError instanceof Error && lastError.name !== 'AbortError') parts.push(lastError.message);

  const detail = parts.length ? parts.join(', ') : 'the request failed';
  const hint = timedOut
    ? ` — the network path to ${host} is not answering; check the machine's connectivity (Settings → Check network)`
    : '';
  throw new NetworkError(
    `${what} could not be reached after ${retries + 1} attempt(s): ${detail}${hint}`,
    { host, timedOut, attempts: retries + 1, ...(lastStatus !== undefined ? { status: lastStatus } : {}), cause: lastError },
  );
}

export interface ReachabilityResult {
  label: string;
  host: string;
  ok: boolean;
  status?: number;
  ms: number;
  address?: string;
  error?: string;
  skipped?: string;
}

/**
 * One host's reachability, for the dashboard's network check.
 *
 * DNS is resolved separately from the HTTP attempt on purpose: "the name does
 * not resolve" and "the name resolves but nothing answers on 443" are different
 * problems with different fixes, and a timeout here is the ambiguous case that
 * makes a dashboard look broken for no stated reason.
 */
export async function checkReachability(
  label: string,
  url: string,
  options: { timeoutMs?: number; expect?: (response: Response) => boolean } = {},
): Promise<ReachabilityResult> {
  const host = hostOf(url);
  const started = Date.now();
  let address: string | undefined;
  try {
    const { lookup } = await import('node:dns/promises');
    const resolved = await lookup(host).catch(() => undefined);
    address = resolved?.address;
  } catch {
    /* address is optional context */
  }

  try {
    const response = await fetchWithPolicy(
      url,
      { method: 'GET', headers: { accept: '*/*' } },
      { timeoutMs: options.timeoutMs ?? 10_000, retries: 0, what: label },
    );
    const ok = options.expect ? options.expect(response) : response.ok || response.status < 500;
    return {
      label,
      host,
      ok,
      status: response.status,
      ms: Date.now() - started,
      ...(address ? { address } : {}),
      ...(ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      label,
      host,
      ok: false,
      ms: Date.now() - started,
      ...(address ? { address } : {}),
      error: error instanceof NetworkError ? error.message.replace(`${label} `, '') : describeNetworkError(error),
    };
  }
}
