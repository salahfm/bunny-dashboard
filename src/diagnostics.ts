/**
 * The network check: which hosts this dashboard can actually reach.
 *
 * A job that dies with `fetch failed` says nothing about *why*, and the two
 * reasons are fixed in completely different places: Bunny's API being unreachable
 * (run the dashboard somewhere that can reach it, or fix the network) versus a
 * playable source not being found (try another host, or another title). This
 * answers the first question in one click, host by host, with the resolved
 * address and the latency, because "it resolves but nothing answers" and "the
 * name does not resolve" are different problems.
 *
 * Bunny's API is the only check that must pass for publishing to work at all;
 * the media CDN and the scraping hosts are reported so a failure can be read for
 * what it is.
 */
import type { AppConfig } from './config';
import { checkReachability, type ReachabilityResult } from './net';

export type ReachabilityProbe = (
  label: string,
  url: string,
  options?: { timeoutMs?: number; expect?: (response: Response) => boolean },
) => Promise<ReachabilityResult>;
import { PROVIDERS } from './providers';
import type { Store } from './store';

export interface DiagnosticCheck extends ReachabilityResult {
  /** `required` = publishing cannot work without it; `optional` = part of the source hunt. */
  role: 'required' | 'optional' | 'playback';
  detail: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  /** True when every check was skipped (mock mode: no network is touched). */
  skipped: boolean;
  checks: DiagnosticCheck[];
  /** One line an operator can act on. */
  summary: string;
  timeoutMs: number;
}

/** A representative URL per scraping host — the same one its resolver would call. */
const PROVIDER_PROBES: Record<string, string> = {
  movy: 'https://vidrack.created.app/api/sources/movy?id=550&type=movie',
  aurora: 'https://vidrack.created.app/api/sources/nova?id=550&type=movie',
  rigel: 'https://movish.to/player-sources/rigel/movie/550',
  vidlink: 'https://enc-dec.app/api/enc-vidlink?text=550',
  vidfast: 'https://vidfast.vc/movie/550',
  cinesrc: 'https://cinesrc.st/embed/movie/550',
};

export interface DiagnosticsDeps {
  config: AppConfig;
  store: Store;
  timeoutMs?: number;
  /** Where the relay is published, when a tunnel is up. */
  tunnelUrl?: string | null;
  /** The prober; tests inject a fake so a check does not need the network. */
  probe?: ReachabilityProbe;
}

export async function runDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  const timeoutMs = deps.timeoutMs ?? Math.max(5_000, Math.min(20_000, deps.config.networkTimeoutMs));
  const checks: DiagnosticCheck[] = [];
  const probe = deps.probe ?? checkReachability;

  const push = async (
    check: Pick<DiagnosticCheck, 'label' | 'role' | 'detail'>,
    url: string,
    expect?: (response: Response) => boolean,
  ) => {
    const result = await probe(check.label, url, { timeoutMs, ...(expect ? { expect } : {}) });
    checks.push({ ...result, role: check.role, detail: check.detail });
  };

  if (deps.config.mock) {
    return {
      ok: true,
      skipped: true,
      checks: [],
      summary: 'mock mode: no network is touched, so nothing was probed',
      timeoutMs,
    };
  }

  // 1. The Bunny API — the one that must work. A 401 is a *reachable* answer
  //    (no key was sent): the question here is connectivity, not credentials.
  await push(
    { label: 'Bunny API', role: 'required', detail: 'video.bunnycdn.com — create videos, upload, poll encoding' },
    'https://video.bunnycdn.com/library/1/videos?page=1&itemsPerPage=1',
    (response) => response.status < 500,
  );

  // 2. Every enabled account's pull zone: playback, not publishing.
  for (const account of deps.store.accounts.filter((entry) => entry.enabled)) {
    if (!account.pullZoneHost) continue;
    const host = account.pullZoneHost.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host) continue;
    await push(
      { label: `pull zone · ${account.name}`, role: 'playback', detail: `${host} — where viewers play the finished video` },
      `https://${host}/`,
      () => true,
    );
  }

  // 3. The scraping hosts, each with the endpoint its resolver calls first.
  for (const provider of PROVIDERS) {
    const url = PROVIDER_PROBES[provider.id];
    if (!url) continue;
    await push(
      { label: provider.name, role: 'optional', detail: `${new URL(url).host} — ${provider.kind === 'api' ? 'JSON resolver' : 'page scan'}` },
      url,
      (response) => response.status < 500,
    );
  }

  // 4. The relay, when a tunnel is up: Bunny has to reach it from outside.
  if (deps.tunnelUrl) {
    await push(
      { label: 'relay (through the tunnel)', role: 'playback', detail: `${deps.tunnelUrl} — where Bunny pulls a stream from` },
      `${deps.tunnelUrl.replace(/\/+$/, '')}/api/health`,
      (response) => response.status < 500,
    );
  }

  const api = checks.find((check) => check.role === 'required');
  const ok = Boolean(api?.ok);
  const optionalDown = checks.filter((check) => check.role === 'optional' && !check.ok);
  const summary = ok
    ? optionalDown.length
      ? `Bunny is reachable; ${optionalDown.length} scraping host(s) did not answer (${optionalDown.map((check) => check.label).join(', ')}) — a scrape can still succeed on the others`
      : 'every host answered'
    : `the Bunny API is NOT reachable from this machine (${api?.error ?? 'no answer'}) — nothing can be published until this works. The dashboard must run somewhere that can reach video.bunnycdn.com.`;

  return { ok, skipped: false, checks, summary, timeoutMs };
}
