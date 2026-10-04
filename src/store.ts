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
  polls: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  libraryId: string;
  apiKeyEnc: string;
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
}

export interface Db {
  version: 1;
  settings: Settings;
  accounts: Account[];
  jobs: Job[];
}

export class Store {
  private config: AppConfig;
  private db: Db;

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
        },
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      };
    } catch {
      fs.renameSync(this.config.dbPath, `${this.config.dbPath}.corrupt-${Date.now()}`);
      return this.defaults();
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    const tmp = `${this.config.dbPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.db, null, 2)}\n`);
    fs.renameSync(tmp, this.config.dbPath);
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

  addAccount(input: { name: string; libraryId: string; apiKeyEnc: string; pullZoneHost?: string }): Account {
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
    return job;
  }

  updateJob(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job | undefined {
    const job = this.job(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return job;
  }

  removeJob(id: string): boolean {
    const index = this.db.jobs.findIndex((job) => job.id === id);
    if (index === -1) return false;
    this.db.jobs.splice(index, 1);
    this.save();
    return true;
  }
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
