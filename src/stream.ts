/**
 * The stream pipeline: scrape a playable URL for a target, download it into a
 * spool file, and get it into Bunny while it is still arriving.
 *
 * The quality rule is the one the dashboard's "Direct scraping" button promises:
 * walk the sources best first (4K → 2K → 1080p → …) and settle on the first one
 * that really carries a tier at or above the floor (1080p by default). A host
 * whose best tier is 720p is not the answer while another host still has 1080p —
 * it is the fallback for when nothing better exists, and the job says so.
 *
 * The transport is Bunny-side fetch through the Cloudflare tunnel when the tunnel
 * answers, and our own resumable upload when it does not. Both read the same
 * spool, so the bytes are downloaded exactly once.
 */
import type { BunnyClient } from './bunny';
import type { AppConfig } from './config';
import {
  StreamSpool,
  downloadSegments,
  measureSegments,
  parseMediaPlaylist,
  resolvePlaylist,
  type HlsSegment,
} from './hls';
import {
  contextFor,
  fetchWithTimeout,
  providerCatalog,
  qualityHeight,
  resolveInputUrl,
  sweepProviders,
  type ProviderFailure,
  type ProviderStream,
} from './providers';
import { relayMasterUrl, relayStreamUrl, type RelayHub } from './relay';
import type { Job, JobCandidate, JobSource, JobTarget, Store } from './store';
import type { TunnelManager } from './tunnel';

/** The tier a scrape must reach before it settles, unless the job asks otherwise. */
export const DEFAULT_MIN_HEIGHT = 1080;
/** How many candidates are probed before the floor is abandoned. */
const MAX_PROBES = 8;
/** Segments downloaded at once. */
const DEFAULT_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 20_000;

export interface StreamDeps {
  config: AppConfig;
  store: Store;
  relay: RelayHub;
  tunnel: TunnelManager;
  log?: (message: string) => void;
}

export interface StreamRunHandles {
  /** Writes job fields, the way the job service does. */
  update(patch: Partial<Job>): void;
  isRunning(): boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampConcurrency(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(16, Math.floor(n)));
}

export function floorFor(minHeight: number | undefined): number {
  return minHeight && minHeight > 0 ? Math.floor(minHeight) : DEFAULT_MIN_HEIGHT;
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

function candidateFor(stream: ProviderStream, note: string): JobCandidate {
  return {
    provider: stream.provider,
    quality: stream.quality,
    url: stream.url,
    height: qualityHeight(stream.quality),
    type: stream.type,
    headers: stream.headers,
    note,
  };
}

function failureNote(failures: ProviderFailure[], provider: string): string {
  const hit = failures.find((failure) => failure.provider === provider);
  return hit ? `${hit.provider}: ${hit.reason}` : `${provider} catalogue`;
}

/** Everything the scrape (or the pasted URL) offered, best-quality first. */
async function gatherCandidates(job: Job, deps: StreamDeps): Promise<JobCandidate[]> {
  const source = job.source;
  if (!source.url) return freshCandidates(job, deps);

  // A retry keeps the URL the first attempt settled on — but these hosts sign
  // their playlists, and a token that has expired turns the retry into a 403 for
  // a source that was fine an hour ago. The kept URL is tried first and a fresh
  // round of sources follows it, so a dead token falls through to a new one.
  const kept: JobCandidate = {
    provider: source.provider ?? 'input',
    quality: source.quality ?? 'Auto',
    url: source.url,
    height: qualityHeight(source.quality ?? 'Auto'),
    headers: source.headers,
    note: 'kept from the previous attempt',
  };
  try {
    return [kept, ...(await freshCandidates(job, deps))];
  } catch (error) {
    deps.log?.(`[stream] ${job.id}: the fresh scrape failed (${describeError(error)}) — trying the kept URL`);
    return [kept];
  }
}

/** What the hosts hand out right now (or what a pasted URL resolves to). */
async function freshCandidates(job: Job, deps: StreamDeps): Promise<JobCandidate[]> {
  const source = job.source;

  if (source.input) {
    const resolution = await resolveInputUrl(source.input, job.target.title);
    deps.log?.(`[stream] ${job.id}: ${resolution.note}`);
    if (resolution.direct) {
      return [
        {
          provider: 'pasted URL',
          quality: 'Auto',
          url: resolution.direct.url,
          height: 0,
          type: resolution.direct.type,
          headers: resolution.direct.headers,
          note: resolution.note,
        },
      ];
    }
    return (resolution.sources ?? []).map((stream) => candidateFor(stream, resolution.note));
  }

  const ctx = contextFor(job.target);
  const { sources, failures } = await sweepProviders(ctx, source.only);
  deps.log?.(`[stream] ${job.id}: ${sources.length} source(s) from ${providerCatalog().length} host(s)`);
  if (!sources.length) {
    const reasons = failures
      .slice(0, 4)
      .map((failure) => `${failure.provider}: ${failure.reason}`)
      .join(' · ');
    throw new Error(`no host handed out a playable source${reasons ? ` (${reasons})` : ''}`);
  }
  return sources.map((stream) => candidateFor(stream, failureNote(failures, stream.provider)));
}

/* ------------------------------------------------------------------ */
/* Probing: what a candidate actually carries                          */
/* ------------------------------------------------------------------ */

export interface Probe {
  /** What the scraper offered (a master playlist, a page, a media file). */
  url: string;
  /** What is actually downloaded: the tier's media playlist, or the file itself. */
  resolvedUrl: string;
  provider: string;
  quality: string;
  headers: Record<string, string>;
  height: number;
  /** A plain media file with a known size, rather than a playlist. */
  directFile: boolean;
  segments: HlsSegment[];
  sizes: number[];
  totalBytes: number;
  label: string;
  /** The chosen variant's declared bitrate, when the master playlist had one. */
  bandwidth?: number;
}

/**
 * Reads one candidate's manifest (or file headers) and reports what it costs.
 *
 * The size has to be known before anything starts: TUS takes its `Upload-Length`
 * at session creation, and the relay has to declare a `Content-Length` for Bunny.
 * A source that cannot state its size is a source this pipeline cannot publish,
 * which is reported as an unusable candidate rather than as a failed job while
 * other hosts are still waiting to be asked.
 */
export async function probeCandidate(
  candidate: JobCandidate,
  options: { headers?: Record<string, string>; onProgress?: (detail: string) => void; maxHeight?: number } = {},
): Promise<Probe> {
  const headers = options.headers ?? candidate.headers ?? {};
  const base = {
    url: candidate.url,
    resolvedUrl: candidate.url,
    provider: candidate.provider,
    quality: candidate.quality,
    headers,
    height: candidate.height,
    label: `${candidate.provider}${candidate.height ? ` ${candidate.height}p` : ''}`,
  };

  const declaredPlaylist = candidate.type === 'hls' || /m3u8/i.test(candidate.url);
  if (!declaredPlaylist) {
    const head = await fetchWithTimeout(candidate.url, { headers, method: 'HEAD' }, PROBE_TIMEOUT_MS);
    const contentType = (head.headers.get('content-type') ?? '').toLowerCase();
    if (/mpegurl|m3u8/.test(contentType)) {
      // It called itself a file and is really a playlist.
    } else {
      if (!head.ok) throw new Error(`the media request failed (HTTP ${head.status})`);
      const bytes = Number(head.headers.get('content-length') ?? 0);
      if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('the source did not report its size');
      return { ...base, directFile: true, segments: [], sizes: [bytes], totalBytes: bytes };
    }
  }

  const playlist = await resolvePlaylist(candidate.url, {
    headers,
    maxHeight: options.maxHeight ?? 2160,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const media = parseMediaPlaylist(playlist.text, playlist.url);
  if (!media.segments.length) throw new Error('the playlist listed no segments');
  if (!media.endList && media.segments.length < 3) {
    throw new Error('that is a live playlist, not a finished recording');
  }

  const measured = await measureSegments(media.segments, {
    headers,
    concurrency: 6,
    onProgress: (done, total) => {
      if (done === total) return;
      options.onProgress?.(`sizing ${candidate.provider}: ${done}/${total} segments`);
    },
  });
  if (measured.bytes === undefined) {
    throw new Error(`${measured.unknown} segment(s) did not report a size, so the upload length is unknown`);
  }

  const chosenVariant = playlist.variants.find((variant) => variant.url === playlist.url);
  return {
    ...base,
    resolvedUrl: playlist.url,
    height: playlist.variantHeight ?? candidate.height,
    directFile: false,
    segments: media.segments,
    sizes: measured.sizes.map((size) => size ?? 0),
    totalBytes: measured.bytes,
    ...(chosenVariant?.bandwidth ? { bandwidth: chosenVariant.bandwidth } : {}),
  };
}

/**
 * Picks the candidate to download: best first, first tier that clears the floor,
 * and the best of everything else when nothing clears it.
 */
export async function chooseCandidate(
  candidates: JobCandidate[],
  options: { floor?: number; onProgress?: (detail: string) => void; maxProbes?: number } = {},
): Promise<{ probe: Probe; candidates: JobCandidate[]; note: string; belowFloor: boolean }> {
  const floor = options.floor && options.floor > 0 ? Math.floor(options.floor) : DEFAULT_MIN_HEIGHT;
  const ordered = [...candidates].sort((a, b) => b.height - a.height);
  const probes = Math.min(options.maxProbes ?? MAX_PROBES, ordered.length);
  const annotated = ordered.map((candidate) => ({ ...candidate }));
  const byUrl = new Map(annotated.map((candidate) => [candidate.url, candidate]));
  const failures: string[] = [];
  let best: Probe | undefined;

  for (let index = 0; index < probes; index += 1) {
    const candidate = ordered[index];
    if (!candidate) break;
    options.onProgress?.(
      `checking ${candidate.provider}${candidate.quality !== 'Auto' ? ` ${candidate.quality}` : ''} (${index + 1}/${probes})`,
    );
    try {
      const probe = await probeCandidate(candidate, { onProgress: options.onProgress });
      const entry = byUrl.get(candidate.url);
      if (entry) {
        entry.height = probe.height;
        entry.directFile = probe.directFile;
      }
      if (!best || probe.height > best.height) best = probe;
      if (probe.height >= floor) {
        if (entry) entry.chosen = true;
        return {
          probe,
          candidates: annotated,
          note: `${probe.label}${probe.directFile ? '' : ` · ${probe.segments.length} segments`}`,
          belowFloor: false,
        };
      }
      options.onProgress?.(`${candidate.provider} tops out at ${probe.height || '?'}p — trying another source`);
    } catch (error) {
      const reason = describeError(error);
      failures.push(`${candidate.provider}: ${reason}`);
      const entry = byUrl.get(candidate.url);
      if (entry) entry.note = `unusable — ${reason}`;
      options.onProgress?.(`${candidate.provider} unusable — ${reason}`);
    }
  }

  if (best) {
    const entry = byUrl.get(best.url);
    if (entry) entry.chosen = true;
    return {
      probe: best,
      candidates: annotated,
      note: `${best.label} — no source reached ${floor}p`,
      belowFloor: true,
    };
  }

  throw new Error(`every source we tried was unusable${failures.length ? ` (${failures.slice(0, 3).join(' · ')})` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Downloading                                                         */
/* ------------------------------------------------------------------ */

/** Streams a plain media file (mp4/mkv/…) into the spool, without buffering it. */
async function downloadDirect(
  url: string,
  spool: StreamSpool,
  headers: Record<string, string>,
  shouldContinue: () => boolean,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const response = await fetchWithTimeout(url, { headers }, 60_000);
  if (!response.ok && response.status !== 206) throw new Error(`the media request failed (HTTP ${response.status})`);
  if (!response.body) throw new Error('the media response had no body');
  const reader = response.body.getReader();
  try {
    for (;;) {
      if (!shouldContinue()) throw new Error('the download was cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        await spool.append(Buffer.from(value));
        onProgress(spool.bytes);
      }
    }
  } catch (error) {
    spool.markFailed(describeError(error));
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

export interface StreamRunResult {
  transport: 'tunnel' | 'direct';
  bytes: number;
  quality: string;
  provider: string;
  relayToken?: string;
}

/**
 * What the pipeline needs from Bunny, and *when* it needs it.
 *
 * Both halves are lazy on purpose. The source has to be resolved and probed
 * before either one runs — a title no host carries must not create anything in
 * the library — and the two transports want different things: an upload needs a
 * video object made by us (`ensureVideo`), while a Bunny-side fetch makes its own
 * and only tells us after the fact (`adoptFetchedVideo`).
 */
export interface StreamUploadTarget {
  title: string;
  client: BunnyClient;
  /** Creates (or reuses) the Bunny video object this job uploads into. */
  ensureVideo(): Promise<string>;
  /** Finds the video Bunny created for its own fetch, when it made one. */
  adoptFetchedVideo(): Promise<string | undefined>;
}

export async function runStreamJob(
  jobId: string,
  deps: StreamDeps,
  handles: StreamRunHandles,
  target: StreamUploadTarget,
): Promise<StreamRunResult> {
  const { client, title } = target;
  const job = deps.store.job(jobId);
  if (!job) throw new Error('the job disappeared');
  const source = job.source;
  const floor = floorFor(source.minHeight);

  // 1. What is on offer for this title?
  handles.update({ stage: 'scraping', detail: 'looking for a source' });
  const found = await gatherCandidates(job, deps);
  if (!found.length) throw new Error('no playable source was found');
  const deduped: JobCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of found) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  handles.update({ candidates: deduped.slice(0, 24), detail: `${deduped.length} candidate source(s)` });

  // 2. Take the best one that clears the floor.
  const choice = await chooseCandidate(deduped, {
    floor,
    onProgress: (detail) => handles.update({ stage: 'probing', detail }),
  });
  const probe = choice.probe;
  const quality = probe.height ? `${probe.height}p` : probe.quality;
  const updateSource = (patch: Partial<JobSource>) => {
    const current = deps.store.job(jobId);
    if (!current) return;
    handles.update({ source: { ...current.source, ...patch } });
  };
  // The *resolved* URL is stored, not the input: a retry then downloads the very
  // same tier instead of re-deciding it, while `source.input` keeps the original.
  updateSource({ url: probe.resolvedUrl, headers: probe.headers, quality, provider: probe.provider });
  handles.update({
    candidates: choice.candidates.slice(0, 24),
    detail: choice.note,
    totalBytes: probe.totalBytes,
  });
  deps.log?.(`[stream] ${jobId}: chose ${choice.note}`);

  const extension: 'ts' | 'mp4' = probe.directFile
    ? 'mp4'
    : probe.segments.some((segment) => Boolean(segment.initUrl)) || /\.(mp4|m4s)(\?|$)/i.test(probe.segments[0]?.url ?? '')
      ? 'mp4'
      : 'ts';
  const contentType = extension === 'mp4' ? 'video/mp4' : 'video/mp2t';

  // 3. One spool file, written by the downloader and read by whatever uploads it.
  const spool = new StreamSpool(deps.config.uploadsDir, jobId, extension);
  spool.total = probe.totalBytes;

  const segments = probe.directFile
    ? [{ duration: 0, offset: 0, bytes: probe.totalBytes }]
    : (() => {
        let offset = 0;
        return probe.segments.map((segment, index) => {
          const bytes = probe.sizes[index] ?? 0;
          const entry = { duration: segment.duration, offset, bytes };
          offset += bytes;
          return entry;
        });
      })();

  const relayToken = deps.relay.register({
    jobId,
    label: `Bunny Publisher ${quality}`,
    spool,
    segments,
    totalBytes: probe.totalBytes,
    extension,
    contentType,
    ...(probe.bandwidth ? { bandwidth: probe.bandwidth } : {}),
  });
  updateSource({ tempPath: spool.path });
  handles.update({ relayToken, stage: 'downloading', transport: 'direct', bytesIn: 0, bytesOut: 0 });

  // An encrypted source is decrypted into the spool, so AES padding makes the
  // real stream shorter than the ciphertext sizes the sizing step measured: its
  // final length is only known once the last segment has arrived.
  const encrypted = probe.segments.some((segment) => Boolean(segment.key));
  let download: Promise<void> | undefined;
  let upload: Promise<void> | undefined;
  let transport: 'tunnel' | 'direct' = 'direct';
  const progressFromDownload = (bytes: number, detail: string) => {
    handles.update({
      stage: 'downloading',
      bytesIn: bytes,
      progress: probe.totalBytes > 0 ? Math.max(1, Math.min(99, Math.round((bytes / probe.totalBytes) * 100))) : 1,
      detail,
    });
  };

  try {
    download = (async () => {
      try {
        if (probe.directFile) {
          await downloadDirect(probe.url, spool, probe.headers, () => handles.isRunning(), (bytes) =>
            progressFromDownload(bytes, `downloading ${probe.label}`),
          );
        } else {
          await downloadSegments(probe.segments, spool, {
            headers: probe.headers,
            concurrency: clampConcurrency(Number(deps.config.streamConcurrency)),
            onProgress: ({ segmentsDone, segmentsTotal, bytes }) =>
              progressFromDownload(bytes, `${segmentsDone}/${segmentsTotal} segments · ${probe.label}`),
            shouldContinue: () => handles.isRunning(),
          });
        }
      } finally {
        await spool.finish().catch(() => undefined);
      }
      // A source that delivered less than its playlists promised would leave
      // Bunny with a truncated file under a length it can never fulfil — and
      // say only "upload failed" afterwards. Refuse it here, with numbers.
      // More than promised is not a failure: a CDN rounds its ranged totals and
      // a playlist can under-state a segment. The file is complete, so it is
      // published at the length it really has (the relay serves real spans).
      if (!encrypted && spool.bytes < probe.totalBytes) {
        throw new Error(
          `the source delivered ${spool.bytes} of the ${probe.totalBytes} bytes its playlists declared — refusing to publish an incomplete file`,
        );
      }
    })();
    // Nothing awaits this until the transport is decided, and that decision can
    // take a while (Bunny's own fetch, then the video it created). A download
    // that fails in that window would be an unhandled rejection — which Node
    // ends the process over, rather than failing the job. The later `await` and
    // `allSettled` still see this rejection.
    void download.catch(() => undefined);

    // 4. Bunny takes it from here when the tunnel is up; otherwise we upload it.
    const publicBase = await deps.tunnel.ensure();
    if (publicBase) {
      // A playlist of segments lets Bunny fetch each one at its true length and
      // retry a slow one on its own; the raw file is only right when the source
      // is a single file whose size is exact (and it still serves ranges).
      const url = probe.directFile ? relayStreamUrl(publicBase, relayToken, extension) : relayMasterUrl(publicBase, relayToken);
      try {
        // A quick tunnel's hostname has existed for seconds: Bunny's resolver
        // can answer “DNS resolution failed” the first time it is asked. That is
        // worth a couple of retries — the alternative is uploading gigabytes
        // from here, which is exactly what the tunnel exists to avoid.
        let result = await client.fetchFromUrl(url, title);
        for (let attempt = 1; attempt < 3 && result.success === false && /dns|resolv/i.test(result.message ?? ''); attempt += 1) {
          handles.update({ detail: `Bunny could not resolve the tunnel yet (${result.message}) — retrying` });
          await new Promise((resolve) => setTimeout(resolve, 4_000 * attempt));
          result = await client.fetchFromUrl(url, title);
        }
        if (result.success === false) throw new Error(result.message || 'Bunny refused to fetch that URL');
        transport = 'tunnel';
        // Bunny created the video itself and does not say which one it is, so the
        // job adopts it by title before anything is polled.
        const adopted = await target.adoptFetchedVideo();
        if (adopted) handles.update({ bunnyVideoId: adopted });
        handles.update({ transport: 'tunnel', detail: `Bunny is pulling the stream through ${publicBase}` });
        deps.log?.(`[stream] ${jobId}: Bunny fetch accepted ${url}${adopted ? ` (video ${adopted})` : ' (video not identified yet)'}`);
      } catch (error) {
        handles.update({ detail: `tunnel fetch refused (${describeError(error)}) — uploading directly` });
        deps.log?.(`[stream] ${jobId}: tunnel fetch failed: ${describeError(error)}`);
      }
    } else {
      handles.update({ detail: 'no tunnel — uploading the bytes ourselves' });
    }

    if (transport === 'tunnel') {
      await download;
      handles.update({ stage: 'downloading', bytesOut: spool.bytes, detail: 'downloaded — Bunny is still pulling' });
    } else {
      // The video object is created here, not at the start of the job: a source
      // that never resolved must not leave an empty video in the library.
      const videoId = await target.ensureVideo();
      upload = (async () => {
        if (encrypted) {
          // With AES padding the declared length can never be met mid-download,
          // so wait for the finished file (whose size is exact) and send it
          // resumably from disk — TUS takes its Upload-Length from the file.
          await download;
          handles.update({ stage: 'uploading', detail: 'the source is encrypted — uploading the finished file' });
          await client.uploadVideoResumable(videoId, spool.path, {
            title,
            fileName: `${title}.${extension}`,
            chunkBytes: deps.config.tusChunkBytes,
            onProgress: (sent, total) =>
              handles.update({
                bytesOut: sent,
                detail: `${Math.round((sent / Math.max(1, total)) * 100)}% handed to Bunny`,
              }),
            shouldContinue: () => handles.isRunning(),
          });
          return;
        }
        handles.update({ stage: 'uploading', detail: 'streaming to Bunny while it downloads' });
        await client.uploadVideoResumable(videoId, undefined, {
          title,
          fileName: `${title}.${extension}`,
          source: { totalBytes: probe.totalBytes, read: (position, length, signal) => spool.read(position, length, signal) },
          chunkBytes: deps.config.tusChunkBytes,
          onProgress: (sent) =>
            handles.update({
              bytesOut: sent,
              detail: `${Math.round((sent / Math.max(1, probe.totalBytes)) * 100)}% handed to Bunny`,
            }),
          shouldContinue: () => handles.isRunning(),
        });
      })();
      const [downloadOutcome, uploadOutcome] = await Promise.allSettled([download, upload]);
      if (uploadOutcome.status === 'rejected') throw uploadOutcome.reason;
      if (downloadOutcome.status === 'rejected') throw downloadOutcome.reason;
      deps.relay.release(relayToken);
      handles.update({ relayToken: undefined });
    }

    return {
      transport,
      bytes: spool.bytes,
      quality,
      provider: probe.provider,
      ...(transport === 'tunnel' ? { relayToken } : {}),
    };
  } catch (error) {
    spool.markFailed(describeError(error));
    await download?.catch(() => undefined);
    await upload?.catch(() => undefined);
    deps.relay.release(relayToken);
    handles.update({ relayToken: undefined });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Preview: what a scrape would pick, without downloading anything     */
/* ------------------------------------------------------------------ */

export interface ScrapePreview {
  candidates: JobCandidate[];
  chosen: JobCandidate | null;
  note: string;
  failures: ProviderFailure[];
}

export async function previewScrape(
  target: JobTarget,
  options: { only?: string[]; minHeight?: number; limit?: number } = {},
): Promise<ScrapePreview> {
  const { sources, failures } = await sweepProviders(contextFor(target), options.only);
  const candidates = sources.map((stream) => candidateFor(stream, failureNote(failures, stream.provider)));
  if (!candidates.length) return { candidates: [], chosen: null, note: 'no host answered with a playable source', failures };

  const deduped: JobCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 5, deduped.length));
  try {
    const choice = await chooseCandidate(deduped, { floor: floorFor(options.minHeight), maxProbes: limit });
    return {
      candidates: choice.candidates,
      chosen: choice.candidates.find((candidate) => candidate.chosen) ?? null,
      note: choice.note,
      failures,
    };
  } catch (error) {
    return { candidates: deduped, chosen: null, note: describeError(error), failures };
  }
}
