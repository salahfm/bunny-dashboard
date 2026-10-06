/**
 * Job orchestration: each job is one upload of one target (movie or episode)
 * into one Bunny Stream library. The service owns the queue lifecycle —
 * queued → uploading → encoding → ready — and keeps the store in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Catalog, CatalogEntry } from './catalog';
import type { AppConfig } from './config';
import { BunnyError, bunnyStatusLabel, mapBunnyStatus, playbackUrlFor, type BunnyClient } from './bunny';
import { isActiveStatus, planAssignments } from './queue';
import type { RelayHub } from './relay';
import type { Account, Job, JobSource, JobTarget, Store } from './store';
import { newJob } from './store';
import { runStreamJob, type StreamDeps } from './stream';
import type { TunnelManager } from './tunnel';

export interface JobServiceDeps {
  store: Store;
  config: AppConfig;
  clientFactory: (account: Account) => BunnyClient;
  relay: RelayHub;
  tunnel: TunnelManager;
  /** Where a finished job's full record is kept; absent means it is not kept. */
  catalog?: Catalog;
  /**
   * Called with the catalogue entry a job just published, once it has been
   * written. This is where a title that finished without one of its subtitle
   * languages gets that language queued — the job worker is the only place that
   * knows a publish just happened.
   */
  onPublished?: (entry: CatalogEntry, job: Job) => void;
  now?: () => number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bunny answers 404/410 when the upload session (or the video object) is gone. */
function isGoneFromBunny(error: unknown): boolean {
  return error instanceof BunnyError && (error.status === 404 || error.status === 410);
}

/**
 * The name a video is created under in the Bunny library, and the key Bunny's
 * own fetch is matched back by.
 *
 * It is the **TMDB id**, not the title: a library full of "Inception (2010)"
 * duplicates is unusable, whereas `tmdb:27205` is unique, stable across
 * releases and re-scrapes, and joins straight back to TMDB (and to this
 * dashboard's own catalogue, whose keys are the same shape). An episode carries
 * its coordinates too, so `tv:1396:S01E02` identifies one episode of one show.
 *
 * The human-readable title still travels with the job (`target.title`,
 * `target.episodeTitle`) and is what the queue, the catalogue and the UI show.
 */
export function jobTitle(target: JobTarget): string {
  if (target.kind === 'movie') return `tmdb:${target.tmdbId}`;
  const season = String(target.season ?? 1).padStart(2, '0');
  const episode = String(target.episode ?? 1).padStart(2, '0');
  return `tv:${target.tmdbId}:S${season}E${episode}`;
}

export function sourceNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : parsed.hostname;
  } catch {
    return url;
  }
}

export class JobService {
  private store: Store;
  private config: AppConfig;
  private clientFactory: (account: Account) => BunnyClient;
  private relay: RelayHub;
  private tunnel: TunnelManager;
  private catalog: Catalog | undefined;
  private onPublished: ((entry: CatalogEntry, job: Job) => void) | undefined;
  private now: () => number;
  private inFlight = new Set<string>();
  private polling = new Set<string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(deps: JobServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.clientFactory = deps.clientFactory;
    this.relay = deps.relay;
    this.tunnel = deps.tunnel;
    this.catalog = deps.catalog;
    this.onPublished = deps.onPublished;
    this.now = deps.now ?? (() => Date.now());
  }

  private get streamDeps(): StreamDeps {
    return { store: this.store, config: this.config, relay: this.relay, tunnel: this.tunnel, log: (message) => console.log(message) };
  }

  /**
   * Anything left "uploading" was interrupted by a restart — put it back in
   * line. A resumable file upload keeps its Bunny session and account, so it
   * continues from the byte Bunny already holds instead of starting over.
   */
  recover(): void {
    for (const job of [...this.store.jobs]) {
      if (job.status !== 'uploading') continue;
      this.requeue(job, 'requeued after the dashboard restarted');
    }
    this.sweepOrphanTempFiles();
  }

  private requeue(job: Job, reason: string): void {
    const resumable = this.canResumeFrom(job);
    this.releaseRelay(job);
    this.store.updateJob(job.id, {
      status: 'queued',
      ...(resumable
        ? {}
        : { accountId: undefined, bunnyVideoId: undefined, tusUploadUrl: undefined, resumeAccountId: undefined, progress: 0 }),
      error: resumable ? `${reason} — the upload will resume where it stopped` : reason,
      ...(job.source.kind === 'stream'
        ? { bytesIn: 0, bytesOut: 0, transport: undefined, relayToken: undefined, detail: undefined, stage: undefined }
        : {}),
    });
  }

  /** Zooms the relay (and with it the spool file) when a job is done with it. */
  private releaseRelay(job: Job | undefined): void {
    if (!job?.relayToken) return;
    this.relay.release(job.relayToken);
    this.store.updateJob(job.id, { relayToken: undefined });
  }

  /**
   * A file job can continue an earlier attempt only while the Bunny library
   * that owns the upload session is still the account it runs on.
   */
  private canResumeFrom(job: Job): boolean {
    return (
      this.config.uploadMode === 'tus' &&
      job.source.kind === 'file' &&
      Boolean(job.bunnyVideoId) &&
      Boolean(job.tusUploadUrl) &&
      Boolean(job.resumeAccountId) &&
      job.accountId === job.resumeAccountId
    );
  }

  /**
   * Removes staged files left in the uploads directory by jobs that no longer
   * exist: `.bin` uploads, and the `.ts`/`.mp4` spools of finished stream jobs.
   * Only files older than an hour are touched, so a spool being written right now
   * cannot be swept out from under its downloader.
   */
  private sweepOrphanTempFiles(): void {
    try {
      const referenced = new Set(
        this.store.jobs
          .map((job) => job.source.tempPath)
          .filter((tempPath): tempPath is string => Boolean(tempPath))
          .map((tempPath) => path.basename(tempPath)),
      );
      const now = this.now();
      for (const name of fs.readdirSync(this.config.uploadsDir)) {
        if (!/\.(bin|ts|mp4)$/i.test(name) || referenced.has(name)) continue;
        const filePath = path.join(this.config.uploadsDir, name);
        // A staged `.bin` is written before its job exists, so it is swept at
        // once; a spool belongs to a live download and is only swept when it is
        // old enough that no downloader could still be filling it.
        if (/\.(ts|mp4)$/i.test(name)) {
          try {
            if (now - fs.statSync(filePath).mtimeMs < 60 * 60_000) continue;
          } catch {
            continue;
          }
        }
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      /* housekeeping only */
    }
  }

  start(): void {
    this.timers.push(setInterval(() => this.tickNow(), this.config.tickIntervalMs));
    this.timers.push(setInterval(() => void this.pollNow(), this.config.pollIntervalMs));
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    // A coalesced progress write may still be in memory; a clean stop keeps it.
    this.store.flush();
  }

  createFileJob(target: JobTarget, tempPath: string, name: string, bytes?: number): Job {
    const job = newJob(target, { kind: 'file', name, tempPath, ...(bytes !== undefined ? { bytes } : {}) });
    return this.store.addJob(job);
  }

  createUrlJob(target: JobTarget, url: string, name?: string): Job {
    const job = newJob(target, { kind: 'url', name: name || sourceNameFromUrl(url), url });
    return this.store.addJob(job);
  }

  /**
   * A job whose bytes this dashboard fetches itself: either by scraping the
   * target's hosts, or from a source URL the operator pasted.
   */
  createStreamJob(
    target: JobTarget,
    options: { mode: 'scrape' | 'source'; input?: string; only?: string[]; minHeight?: number; name?: string },
  ): Job {
    const source: JobSource = {
      kind: 'stream',
      mode: options.mode,
      name: options.name || (options.input ? sourceNameFromUrl(options.input) : jobTitle(target)),
      ...(options.input ? { input: options.input } : {}),
      ...(options.only && options.only.length ? { only: options.only } : {}),
      // Kept as given (0 included): 0 means "take the best tier available",
      // while an absent value means "use the default floor".
      ...(options.minHeight !== undefined && Number.isFinite(options.minHeight)
        ? { minHeight: Math.max(0, Math.floor(options.minHeight)) }
        : {}),
    };
    return this.store.addJob(newJob(target, source));
  }

  /** Assign queued jobs to accounts with free capacity and start them. */
  tickNow(): void {
    const assignments = planAssignments(this.store.jobs, this.store.accounts, this.store.settings.perAccountConcurrency);
    for (const assignment of assignments) {
      if (this.inFlight.has(assignment.jobId)) continue;
      const job = this.store.job(assignment.jobId);
      if (!job || job.status !== 'queued') continue;
      this.store.updateJob(job.id, {
        status: 'uploading',
        accountId: assignment.accountId,
        startedAt: new Date().toISOString(),
        attempts: job.attempts + 1,
      });
      this.inFlight.add(job.id);
      void this.run(job.id).finally(() => this.inFlight.delete(job.id));
    }
    this.requeueStaleUploads();
  }

  private requeueStaleUploads(): void {
    const staleAfterMs = 5 * 60_000;
    for (const job of [...this.store.jobs]) {
      if (job.status !== 'uploading' || this.inFlight.has(job.id)) continue;
      if (this.now() - Date.parse(job.updatedAt) > staleAfterMs) {
        // A hung request may still be writing to its Bunny session, so this
        // attempt starts over with a fresh video object.
        this.store.updateJob(job.id, {
          status: 'queued',
          accountId: undefined,
          bunnyVideoId: undefined,
          tusUploadUrl: undefined,
          resumeAccountId: undefined,
          error: 'the previous attempt was interrupted; queued again',
        });
      }
    }
  }

  private isStillRunning(jobId: string): boolean {
    return this.store.job(jobId)?.status === 'uploading';
  }

  private async run(jobId: string): Promise<void> {
    const job = this.store.job(jobId);
    if (!job || job.status !== 'uploading' || !job.accountId) return;
    const account = this.store.account(job.accountId);
    if (!account) {
      this.fail(jobId, 'the account for this job no longer exists');
      return;
    }
    const client = this.clientFactory(account);
    const title = jobTitle(job.target);
    let videoId: string | undefined;

    /**
     * The video object this dashboard uploads into, made on demand.
     *
     * On demand because a job must not leave an empty video behind: the object
     * appears only once there is something to put in it (the source resolved, the
     * uploaded file is on disk), and a job that fails before that leaves the
     * library exactly as it found it.
     */
    const ensureVideo = async (): Promise<string> => {
      const current = this.store.job(jobId);
      if (!current) throw new Error('the job disappeared');
      if (current.bunnyVideoId) return current.bunnyVideoId;
      if (current.tusUploadUrl || current.resumeAccountId) {
        this.store.updateJob(jobId, { tusUploadUrl: undefined, resumeAccountId: undefined });
      }
      const video = await client.createVideo(title);
      if (!this.isStillRunning(jobId)) {
        this.abandon(account, video.guid);
        throw new Error('the job was cancelled');
      }
      this.store.updateJob(jobId, { bunnyVideoId: video.guid, progress: 0 });
      return video.guid;
    };

    try {
      if (job.source.kind === 'stream') {
        // Nothing is created in the library until the source has been resolved
        // and measured — the pipeline asks for the video object itself.
        const result = await runStreamJob(
          jobId,
          this.streamDeps,
          {
            update: (patch) => {
              if (this.store.job(jobId)?.status === 'uploading') this.store.updateJob(jobId, patch);
            },
            isRunning: () => this.isStillRunning(jobId),
          },
          {
            title,
            client,
            ensureVideo,
            adoptFetchedVideo: () => this.adoptFetchedVideo(client, title),
          },
        );
        videoId = this.store.job(jobId)?.bunnyVideoId;
        this.store.updateJob(jobId, {
          bytesIn: result.bytes,
          bytesOut: result.bytes,
          transport: result.transport,
          stage: 'encoding',
          detail:
            result.transport === 'tunnel'
              ? `${result.quality} · ${result.provider} · Bunny pulled the stream`
              : `${result.quality} · ${result.provider} · uploaded directly`,
        });
      } else if (job.source.kind === 'file') {
        if (this.canResumeFrom(job)) {
          videoId = job.bunnyVideoId as string;
        } else {
          // A leftover video object from an earlier attempt would only clutter the library.
          if (job.bunnyVideoId) {
            this.abandon(account, job.bunnyVideoId);
            this.store.updateJob(jobId, { bunnyVideoId: undefined });
          }
          videoId = await ensureVideo();
        }
        const tempPath = job.source.tempPath;
        if (!tempPath || !fs.existsSync(tempPath)) throw new Error('the uploaded file is no longer on disk — cancel this job and upload the file again');
        if (this.config.uploadMode === 'tus') {
          await this.uploadFileResumable(jobId, client, account, videoId, tempPath, title, job.source.name);
        } else {
          await client.uploadVideo(videoId, tempPath);
        }
      } else {
        // Bunny fetches it, and Bunny makes the video itself — this endpoint does
        // not return the id, so the job adopts whatever it created by title.
        if (job.bunnyVideoId) {
          this.abandon(account, job.bunnyVideoId);
          this.store.updateJob(jobId, { bunnyVideoId: undefined });
        }
        const url = job.source.url;
        if (!url) throw new Error('this job has no source URL');
        const result = await client.fetchFromUrl(url, title);
        if (result.success === false) throw new Error(result.message || 'Bunny refused to fetch that URL');
        const adopted = await this.adoptFetchedVideo(client, title);
        videoId = adopted;
        this.store.updateJob(jobId, {
          bunnyVideoId: adopted,
          detail: adopted ? undefined : 'Bunny accepted the fetch; its video has not appeared in the library yet',
        });
      }

      if (!this.isStillRunning(jobId)) {
        this.abandon(account, videoId);
        return;
      }
      this.store.updateJob(jobId, { status: 'encoding', progress: 0, statusCode: undefined });
    } catch (error) {
      if (this.store.job(jobId)?.status === 'cancelled') {
        this.abandon(account, videoId);
        return;
      }
      if (job.source.kind === 'file' && this.canResumeFrom(job) && isGoneFromBunny(error)) {
        await this.restartFileUpload(jobId, client, account, videoId, title).catch((restartError) => this.fail(jobId, describeError(restartError)));
        return;
      }
      this.fail(jobId, describeError(error));
    }
  }

  /** Upload a file with TUS, reporting progress and honouring cancellation. */
  private async uploadFileResumable(
    jobId: string,
    client: BunnyClient,
    account: Account,
    videoId: string,
    tempPath: string,
    title: string,
    fileName: string,
  ): Promise<void> {
    const resumeUrl = this.store.job(jobId)?.tusUploadUrl;
    await client.uploadVideoResumable(videoId, tempPath, {
      title,
      fileName: fileName || tempPath,
      chunkBytes: this.config.tusChunkBytes,
      ...(resumeUrl ? { resumeUrl } : {}),
      onUploadUrl: (uploadUrl) => {
        if (this.store.job(jobId)?.status === 'uploading') this.store.updateJob(jobId, { tusUploadUrl: uploadUrl, resumeAccountId: account.id });
      },
      onProgress: (bytesSent, totalBytes) => this.recordUploadProgress(jobId, bytesSent, totalBytes),
      shouldContinue: () => this.isStillRunning(jobId),
    });
  }

  /** The Bunny video (and with it the upload session) disappeared: start a fresh object. */
  private async restartFileUpload(
    jobId: string,
    client: BunnyClient,
    account: Account,
    staleVideoId: string | undefined,
    title: string,
  ): Promise<void> {
    const job = this.store.job(jobId);
    if (!job || job.source.kind !== 'file' || !job.source.tempPath) return;
    this.abandon(account, staleVideoId);
    this.store.updateJob(jobId, { bunnyVideoId: undefined, tusUploadUrl: undefined, resumeAccountId: undefined, progress: 0 });
    const video = await client.createVideo(title);
    if (!this.isStillRunning(jobId)) {
      this.abandon(account, video.guid);
      return;
    }
    this.store.updateJob(jobId, { bunnyVideoId: video.guid });
    await this.uploadFileResumable(jobId, client, account, video.guid, job.source.tempPath, title, job.source.name);
    if (!this.isStillRunning(jobId)) {
      this.abandon(account, video.guid);
      return;
    }
    this.store.updateJob(jobId, { status: 'encoding', progress: 0, statusCode: undefined });
  }

  private recordUploadProgress(jobId: string, bytesSent: number, totalBytes: number): void {
    const job = this.store.job(jobId);
    if (!job || job.status !== 'uploading') return;
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((bytesSent / totalBytes) * 100))) : 0;
    if (percent === job.progress) return;
    this.store.updateJob(jobId, { progress: percent });
  }

  /**
   * The video Bunny created for its own fetch, matched by title.
   *
   * `POST /videos/fetch` answers `{ success, message }` and nothing else, so the
   * only way to poll what it downloaded is to look for it: the newest video in
   * the library whose title is exactly the one the fetch was given. Returns
   * undefined when it has not shown up yet, which is normal — Bunny creates the
   * object asynchronously — and the poll loop keeps looking.
   */
  private async adoptFetchedVideo(client: BunnyClient, title: string): Promise<string | undefined> {
    try {
      const page = await client.listVideos(25);
      const items = Array.isArray(page.items) ? page.items : [];
      const match = items
        .filter((video) => String(video.title ?? '') === title)
        .sort((a, b) => String(b.dateUploaded ?? '').localeCompare(String(a.dateUploaded ?? '')))[0];
      return match?.guid;
    } catch {
      return undefined;
    }
  }

  /** A job whose video Bunny is still expected to create (a fetch, not an upload). */
  private needsAdoption(job: Job): boolean {
    return !job.bunnyVideoId && job.source.kind === 'url';
  }

  /**
   * Read encoding progress for every job Bunny is still working on.
   *
   * Bounded concurrency on purpose: a full queue holds up to
   * `accounts × perAccountConcurrency` (300 by default) encoding jobs, and
   * firing 300 status requests at Bunny every 10 s invites throttling and a
   * poll backlog that outlives the interval. A small pool drains the list
   * quickly without hammering the API.
   */
  async pollNow(): Promise<void> {
    const active = this.store.jobs.filter(
      (job) => job.status === 'encoding' && job.accountId && (job.bunnyVideoId || this.needsAdoption(job)),
    );
    await this.runPool(active.map((job) => () => this.pollJob(job.id)), 8);
    // A Bunny pull that died leaves its relay (and spool file) behind; this is
    // where it is noticed. The download is over either way — nobody is waiting
    // on those bytes any more.
    for (const jobId of this.relay.sweepIdle()) {
      this.store.updateJob(jobId, { relayToken: undefined, detail: 'the relay was released after sitting idle' });
    }
  }

  /** Runs `tasks` with at most `limit` in flight, resolving once all are done. */
  private async runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      for (;;) {
        const task = queue.shift();
        if (!task) return;
        await task().catch(() => undefined);
      }
    });
    await Promise.all(workers);
  }

  private async pollJob(jobId: string): Promise<void> {
    if (this.polling.has(jobId)) return;
    this.polling.add(jobId);
    try {
      const job = this.store.job(jobId);
      if (!job || job.status !== 'encoding' || !job.accountId) return;
      const account = this.store.account(job.accountId);
      if (!account) {
        this.fail(jobId, 'the account for this job no longer exists');
        return;
      }
      const client = this.clientFactory(account);

      if (!job.bunnyVideoId) {
        if (!this.needsAdoption(job)) return;
        const adopted = await this.adoptFetchedVideo(client, jobTitle(job.target));
        if (!adopted) {
          const polls = job.polls + 1;
          if (polls > this.config.maxPollsPerJob) {
            this.fail(jobId, 'Bunny accepted the fetch but no video with that title appeared in the library');
          } else {
            this.store.updateJob(jobId, { polls });
          }
          return;
        }
        this.store.updateJob(jobId, { bunnyVideoId: adopted });
        job.bunnyVideoId = adopted;
      }

      if (!job.bunnyVideoId) return;
      const video = await client.getVideo(job.bunnyVideoId);
      const outcome = mapBunnyStatus(video.status);
      const progress = Number.isFinite(video.encodeProgress) ? Math.max(0, Math.min(100, Math.round(video.encodeProgress))) : job.progress;

      if (outcome === 'ready') {
        const ready = this.store.updateJob(jobId, {
          status: 'ready',
          progress: 100,
          statusCode: video.status,
          playbackUrl: playbackUrlFor(account.pullZoneHost, job.bunnyVideoId),
          finishedAt: new Date().toISOString(),
          error: undefined,
        });
        // The permanent record is written here, not when the job is created —
        // "published" means Bunny finished encoding it, with everything the
        // job learned along the way (every source, every quality rung).
        if (ready) this.publish(ready, account);
        // Bunny has everything it needs from the relay by now.
        this.releaseRelay(job);
        this.cleanupTemp(job);
        return;
      }
      if (outcome === 'failed') {
        const detail = typeof video.errorMessage === 'string' && video.errorMessage ? `: ${video.errorMessage}` : '';
        this.releaseRelay(job);
        this.fail(jobId, `Bunny reported “${bunnyStatusLabel(video.status)}”${detail}`);
        return;
      }

      const polls = job.polls + 1;
      if (polls > this.config.maxPollsPerJob) {
        this.fail(jobId, 'timed out waiting for Bunny to finish encoding');
        return;
      }
      this.store.updateJob(jobId, { progress, statusCode: video.status, polls, error: undefined });
    } catch (error) {
      // Transient API hiccups are retried until the poll budget runs out.
      const job = this.store.job(jobId);
      if (job && job.status === 'encoding') {
        const polls = job.polls + 1;
        if (polls > this.config.maxPollsPerJob) this.fail(jobId, `could not read the encoding status: ${describeError(error)}`);
        else this.store.updateJob(jobId, { polls });
      }
    } finally {
      this.polling.delete(jobId);
    }
  }

  /** Records a finished job in the published catalogue, if one is configured. */
  private publish(job: Job, account: Account): void {
    if (!this.catalog) return;
    let entry: CatalogEntry;
    try {
      entry = this.catalog.record(job, account);
    } catch (error) {
      // Losing the record must never fail a job that is already published.
      console.error(`[catalog] could not record ${job.id}: ${describeError(error)}`);
      return;
    }
    // The hook acts *after* the record exists, so it can read the entry (the
    // tracks the publish attached) rather than the job's own copy. It must not
    // be able to break a publish either.
    try {
      this.onPublished?.(entry, job);
    } catch (error) {
      console.error(`[catalog] the published-title hook failed for ${job.id}: ${describeError(error)}`);
    }
  }

  retry(jobId: string): Job | undefined {
    const job = this.store.job(jobId);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return job;
    // An interrupted resumable upload keeps its Bunny session, account and the
    // temp file, so the retry continues from the byte Bunny already has.
    const resumable = this.canResumeFrom(job);
    return this.store.updateJob(jobId, {
      status: 'queued',
      ...(resumable
        ? {}
        : { accountId: undefined, bunnyVideoId: undefined, tusUploadUrl: undefined, resumeAccountId: undefined, progress: 0 }),
      playbackUrl: undefined,
      statusCode: undefined,
      polls: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      // The previous attempt's counters must not show under the new one while it
      // is still scraping; the relay (if any) was released when it ended.
      bytesIn: undefined,
      bytesOut: undefined,
      transport: undefined,
      relayToken: undefined,
      stage: undefined,
      detail: undefined,
      candidates: undefined,
    });
  }

  cancel(jobId: string): Job | undefined {
    const job = this.store.job(jobId);
    if (!job || (!isActiveStatus(job.status) && job.status !== 'queued')) return job;
    this.releaseRelay(job);
    const updated = this.store.updateJob(jobId, {
      status: 'cancelled',
      tusUploadUrl: undefined,
      resumeAccountId: undefined,
      relayToken: undefined,
      finishedAt: new Date().toISOString(),
    });
    this.cleanupTemp(job);
    if (job.bunnyVideoId && job.accountId) {
      const account = this.store.account(job.accountId);
      if (account) this.abandon(account, job.bunnyVideoId);
    }
    return updated;
  }

  remove(jobId: string): boolean {
    const job = this.store.job(jobId);
    if (!job || isActiveStatus(job.status)) return false;
    this.cleanupTemp(job);
    return this.store.removeJob(jobId);
  }

  private abandon(account: Account, videoId: string | undefined): void {
    if (!videoId) return;
    void this.clientFactory(account).deleteVideo(videoId).catch(() => undefined);
  }

  private fail(jobId: string, message: string): void {
    const job = this.store.job(jobId);
    if (!job) return;
    this.releaseRelay(job);
    this.store.updateJob(jobId, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    // A resumable upload keeps its temp file so Retry can pick up where it stopped.
    if (!this.canResumeFrom(job)) this.cleanupTemp(job);
  }

  private cleanupTemp(job: Job): void {
    const tempPath = job.source.tempPath;
    if (!tempPath) return;
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* best effort */
    }
  }

  /** The relay hub, so the server can mount it. */
  get relayHub(): RelayHub {
    return this.relay;
  }
}
