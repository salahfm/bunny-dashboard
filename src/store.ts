import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import { clampConcurrency, clampMaxAccounts } from './config';

export type JobStatus = 'queued' | 'uploading' | 'encoding' | 'ready' | 'failed' | 'cancelled';
export type TargetKind = 'movie' | 'episode';

export interface JobTarget {
  kind: TargetKind;
  tmdbId: number;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  posterPath?: string | null;
}

export interface JobSource {
  /** `file` = uploaded to the dashboard; `url` = Bunny fetches it; `stream` = we scrape/download it first. */
  kind: 'file' | 'url' | 'stream';
  name: string;
  /** For `url`: what Bunny fetches. For `stream`: the resolved media URL we download. */
  url?: string;
  tempPath?: string;
  bytes?: number;
  /** What the user pasted, when it was not the media URL itself. */
  input?: string;
  /** Which scrape mode this job came from. */
  mode?: 'scrape' | 'source';
  /** Hosts the scrape may use (provider ids); empty means all of them. */
  only?: string[];
  /** Lowest tier the scrape is allowed to settle for, in pixels (default 1080). */
  minHeight?: number;
  /** The tier this job ended up downloading. */
  quality?: string;
  /** Which provider handed the chosen URL out. */
  provider?: string;
  /** The media CDN's required headers, so a retry can fetch the same screen again. */
  headers?: Record<string, string>;
  /**
   * Every tier the chosen source offers, best first — the ladder its master
   * playlist declared (a single entry for a plain file). Recorded so the
   * published catalogue can say which qualities were available, not just the
   * one that happened to be downloaded.
   */
  tiers?: SourceTier[];
}

/** One rung of a source's quality ladder. */
export interface SourceTier {
  label: string;
  height: number;
  url: string;
  bandwidth?: number;
}

/** One candidate the scrape found, kept on the job so the dashboard can show the ladder. */
export interface JobCandidate {
  provider: string;
  quality: string;
  url: string;
  height: number;
  /** `hls` for a playlist, `mp4` for a plain media file. */
  type?: 'hls' | 'mp4';
  /** Set once probed: the candidate is a plain media file, not a playlist. */
  directFile?: boolean;
  /** The media CDN's required headers for this candidate. */
  headers?: Record<string, string>;
  chosen?: boolean;
  note?: string;
}

export interface Job {
  id: string;
  accountId?: string;
  target: JobTarget;
  source: JobSource;
  status: JobStatus;
  progress: number;
  statusCode?: number;
  bunnyVideoId?: string;
  /** Location URL of the in-progress TUS upload, so a later attempt can resume it. */
  tusUploadUrl?: string;
  /** The account whose Bunny library owns the upload session above. */
  resumeAccountId?: string;
  playbackUrl?: string;
  error?: string;
  /** Stream jobs: what is happening right now, in one line. */
  stage?: string;
  detail?: string;
  /** Stream jobs: bytes pulled from the source, bytes handed to Bunny, expected total. */
  bytesIn?: number;
  bytesOut?: number;
  totalBytes?: number;
  /** How the bytes reached Bunny: Bunny pulling through the tunnel, or our own upload. */
  transport?: 'tunnel' | 'direct';
  /** The relay path Bunny is fetching from, while the tunnel transport is live. */
  relayToken?: string;
  /** Every source the scrape found, best first. */
  candidates?: JobCandidate[];
  /**
   * The subtitle tracks carried to Bunny for this video.
   *
   * One entry per caption Bunny now holds: what the stream offered (or the
   * translation of it), the language it was filed under, and whether the upload
   * actually landed. Recorded on the job so "did this get subtitles, and which?"
   * is answerable without reopening Bunny.
   */
  subtitles?: SubtitleTrack[];
  polls: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * What happened to a job, as the live queue stream reports it.
 *
 * `added` and `removed` mean the row appeared or vanished; `updated` means one
 * or more of its visible fields moved (a status, a progress tick, a byte count).
 */
export type JobChangeKind = 'added' | 'updated' | 'removed';

type JobListener = (job: Job, kind: JobChangeKind) => void;

/** One subtitle track carried to Bunny, as the job's report keeps it. */
export interface SubtitleTrack {
  /** The ISO 639-1 code the caption was filed under with Bunny. */
  srclang: string;
  /** The label a player shows for it. */
  label: string;
  /** The URL the text was scraped from (absent for a translation). */
  url?: string;
  /** What the manifest/host called the language, before normalisation. */
  language?: string;
  /** Bunny accepted the caption. */
  uploaded: boolean;
  /** It was translated from another track rather than scraped. */
  translated?: boolean;
  /** The track a translation was made from, e.g. `en`. */
  translatedFrom?: string;
  /** Cues in the track, and the bytes handed to Bunny. */
  cues?: number;
  bytes?: number;
  note?: string;
}

export interface Account {
  id: string;
  name: string;
  libraryId: string;
  /** The Stream library API key, what `BunnyClient` uploads with. */
  apiKeyEnc: string;
  /**
   * The *account* API key, when one was given.
   *
   * It is deliberately not what publishing uses: the account key is only for
   * the account-level API, which is where a library's watermark and its enabled
   * resolutions live. Keeping it lets the dashboard re-apply the shared
   * watermark to this library later without asking for the key again.
   */
  accountApiKeyEnc?: string;
  pullZoneHost?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  tmdbApiKeyEnc?: string;
  tmdbAccessTokenEnc?: string;
  perAccountConcurrency: number;
  maxAccounts: number;
  /** Folder scanned for new video files; seeded from WATCH_DIR on first run. */
  watchDir?: string;
  watchEnabled: boolean;
  /**
   * Fill in a target language a finished publish left missing, without being
   * asked. On by default: the usual reason a language is absent is a refused
   * translation, which one more try a minute later fixes.
   */
  subtitleAutoFill: boolean;
  /**
   * Copy a finished title into R2 (and let Bunny forget it) without being asked.
   * Only meaningful when the R2 destination is configured at all; the default
   * follows the R2_ARCHIVE switch, and this is what the dashboard toggles.
   */
  archiveToR2: boolean;
}

export interface Db {
  version: 1;
  settings: Settings;
  accounts: Account[];
  jobs: Job[];
}

/**
 * Job fields that change on every uploaded chunk or downloaded segment.
 *
 * Writing the whole database for one of these is the difference between a few
 * writes a second and a few hundred: a busy queue calls `updateJob` with a new
 * `progress` (or byte count) many times a second, and each call would otherwise
 * re-serialise every job — candidates and all — and block the event loop doing
 * it. These are coalesced; everything else is written immediately.
 */
const VOLATILE_JOB_FIELDS = new Set<keyof Job>(['progress', 'bytesIn', 'bytesOut', 'stage', 'detail']);

/** How long a coalesced progress write may stay only in memory. */
const SAVE_DEBOUNCE_MS = 100;

export class Store {
  private config: AppConfig;
  private db: Db;
  private savePending = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private jobListeners = new Set<JobListener>();

  constructor(config: AppConfig) {
    this.config = config;
    this.db = this.load();
  }

  private defaults(): Db {
    return {
      version: 1,
      settings: {
        perAccountConcurrency: clampConcurrency(this.config.perAccountConcurrency),
        maxAccounts: clampMaxAccounts(this.config.maxAccounts),
        ...(this.config.watchDir ? { watchDir: this.config.watchDir } : {}),
        watchEnabled: true,
        subtitleAutoFill: true,
        archiveToR2: this.config.r2?.enabled ?? false,
      },
      accounts: [],
      jobs: [],
    };
  }

  private load(): Db {
    if (!fs.existsSync(this.config.dbPath)) return this.defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.dbPath, 'utf8')) as Partial<Db>;
      const base = this.defaults();
      return {
        version: 1,
        settings: {
          ...base.settings,
          ...(raw.settings ?? {}),
          perAccountConcurrency: clampConcurrency(raw.settings?.perAccountConcurrency, base.settings.perAccountConcurrency),
          maxAccounts: clampMaxAccounts(raw.settings?.maxAccounts, base.settings.maxAccounts),
          watchEnabled: raw.settings?.watchEnabled !== false,
          subtitleAutoFill: raw.settings?.subtitleAutoFill !== false,
          // A stored choice wins; with none, the R2_ARCHIVE switch decides.
          archiveToR2: typeof raw.settings?.archiveToR2 === 'boolean' ? raw.settings.archiveToR2 : base.settings.archiveToR2,
        },
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      };
    } catch {
      fs.renameSync(this.config.dbPath, `${this.config.dbPath}.corrupt-${Date.now()}`);
      return this.defaults();
    }
  }

  /** Writes the database now, cancelling any pending coalesced write. */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.savePending = false;
    fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    const tmp = `${this.config.dbPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.db, null, 2)}\n`);
    fs.renameSync(tmp, this.config.dbPath);
  }

  /**
   * Writes soon rather than now: a burst of progress updates lands as one write.
   * The timer is unref'd so a pending write never keeps the process alive.
   */
  private saveSoon(): void {
    this.savePending = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.savePending) this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** Persists anything a coalesced write left in memory (e.g. on shutdown). */
  flush(): void {
    if (this.savePending || this.saveTimer) this.save();
  }

  /** True when a coalesced write is still pending — used by tests. */
  get hasPendingSave(): boolean {
    return this.savePending;
  }

  /**
   * Watch the queue. The dashboard's live event stream is the subscriber: it is
   * told *which* job moved and *how*, so it can push that one row to the browser
   * instead of the browser re-reading the whole list.
   *
   * Every mutation path goes through this — the job worker, the autopilot, the
   * watched folder and the API routes alike — so nothing can change a job
   * without the stream hearing about it.
   */
  onJobChange(listener: JobListener): () => void {
    this.jobListeners.add(listener);
    return () => {
      this.jobListeners.delete(listener);
    };
  }

  /**
   * Fans a change out to the listeners. A listener that throws is logged and
   * skipped: reporting a change must never be able to break the queue itself.
   */
  private emitJob(job: Job, kind: JobChangeKind): void {
    if (this.jobListeners.size === 0) return;
    for (const listener of [...this.jobListeners]) {
      try {
        listener(job, kind);
      } catch (error) {
        console.error('[store] a job listener failed:', error);
      }
    }
  }

  get settings(): Settings {
    return this.db.settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.db.settings = { ...this.db.settings, ...patch };
    this.save();
    return this.db.settings;
  }

  get accounts(): Account[] {
    return this.db.accounts;
  }

  account(id: string): Account | undefined {
    return this.db.accounts.find((account) => account.id === id);
  }

  addAccount(input: { name: string; libraryId: string; apiKeyEnc: string; accountApiKeyEnc?: string; pullZoneHost?: string }): Account {
    const now = new Date().toISOString();
    const account: Account = {
      id: crypto.randomUUID(),
      name: input.name,
      libraryId: input.libraryId,
      apiKeyEnc: input.apiKeyEnc,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    if (input.accountApiKeyEnc) account.accountApiKeyEnc = input.accountApiKeyEnc;
    if (input.pullZoneHost) account.pullZoneHost = input.pullZoneHost;
    this.db.accounts.push(account);
    this.save();
    return account;
  }

  updateAccount(id: string, patch: Partial<Omit<Account, 'id' | 'createdAt'>>): Account | undefined {
    const account = this.account(id);
    if (!account) return undefined;
    Object.assign(account, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return account;
  }

  removeAccount(id: string): boolean {
    const index = this.db.accounts.findIndex((account) => account.id === id);
    if (index === -1) return false;
    this.db.accounts.splice(index, 1);
    this.save();
    return true;
  }

  get jobs(): Job[] {
    return this.db.jobs;
  }

  job(id: string): Job | undefined {
    return this.db.jobs.find((job) => job.id === id);
  }

  addJob(job: Job): Job {
    this.db.jobs.push(job);
    this.save();
    this.emitJob(job, 'added');
    return job;
  }

  updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job | undefined {
    const job = this.job(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    // A patch that only moves a byte counter is not worth a full rewrite;
    // anything structural (a status change, a session URL, …) is written at once.
    const keys = Object.keys(patch) as Array<keyof Job>;
    if (keys.length > 0 && keys.every((key) => VOLATILE_JOB_FIELDS.has(key))) this.saveSoon();
    else this.save();
    this.emitJob(job, 'updated');
    return job;
  }

  removeJob(id: string): boolean {
    const index = this.db.jobs.findIndex((job) => job.id === id);
    if (index === -1) return false;
    const [removed] = this.db.jobs.splice(index, 1);
    this.save();
    // Reported after the splice, so a listener that re-reads the queue sees the
    // job already gone rather than removing a row that is about to come back.
    if (removed) this.emitJob(removed, 'removed');
    return true;
  }
}

/**
 * The identity of a target, for "is this already queued?" and for the published
 * catalogue: a movie is its TMDB id, an episode is the show plus its numbers (so
 * season 2 twice is one identity while season 3 is another).
 *
 * Kept here rather than in `bulk.ts` because the queue and the catalogue must
 * agree on what "the same title" means.
 */
export function targetKey(target: JobTarget): string {
  return target.kind === 'movie'
    ? `movie:${target.tmdbId}`
    : `episode:${target.tmdbId}:${target.season ?? 0}:${target.episode ?? 0}`;
}

export function newJob(target: JobTarget, source: JobSource): Job {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    target,
    source,
    status: 'queued',
    progress: 0,
    polls: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}
