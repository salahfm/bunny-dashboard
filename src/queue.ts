/**
 * The scheduler heart: given jobs and accounts it decides which queued jobs may
 * start right now. Kept as pure functions so the concurrency rules can be
 * tested without a server, a file system, or Bunny.
 */
import { clampConcurrency } from './config';
import type { Account, Job, JobStatus } from './store';

export interface Assignment {
  jobId: string;
  accountId: string;
}

export function isActiveStatus(status: JobStatus): boolean {
  return status === 'uploading' || status === 'encoding';
}

export function activeCounts(jobs: Job[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!job.accountId || !isActiveStatus(job.status)) continue;
    counts.set(job.accountId, (counts.get(job.accountId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fill every enabled account up to `perAccountConcurrency` (hard-capped at 10),
 * oldest queued job first, spreading jobs across accounts as evenly as possible.
 */
export function planAssignments(jobs: Job[], accounts: Account[], perAccountConcurrency: number): Assignment[] {
  const cap = clampConcurrency(perAccountConcurrency);
  const counts = activeCounts(jobs);
  const slots = new Map<string, number>();
  for (const account of accounts) {
    if (!account.enabled) continue;
    slots.set(account.id, Math.max(0, cap - (counts.get(account.id) ?? 0)));
  }

  const queued = jobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  const assignedPer = new Map<string, number>();
  const assignments: Assignment[] = [];
  for (const job of queued) {
    // A job that already owns a Bunny upload session keeps its account so the
    // resumable upload can continue from the byte Bunny already has.
    const pinned = job.resumeAccountId;
    if (pinned) {
      const free = slots.get(pinned) ?? 0;
      if (free > 0) {
        assignments.push({ jobId: job.id, accountId: pinned });
        assignedPer.set(pinned, (assignedPer.get(pinned) ?? 0) + 1);
        slots.set(pinned, free - 1);
        continue;
      }
    }

    let bestId: string | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [accountId, free] of slots) {
      if (free <= 0) continue;
      const used = (counts.get(accountId) ?? 0) + (assignedPer.get(accountId) ?? 0);
      const score = free * 1000 - used;
      if (score > bestScore) {
        bestScore = score;
        bestId = accountId;
      }
    }
    if (!bestId) break;
    assignments.push({ jobId: job.id, accountId: bestId });
    assignedPer.set(bestId, (assignedPer.get(bestId) ?? 0) + 1);
    slots.set(bestId, (slots.get(bestId) ?? 1) - 1);
  }
  return assignments;
}

export interface QueueStats {
  counts: Record<JobStatus, number>;
  total: number;
  active: number;
  queued: number;
  capacity: number;
  perAccountConcurrency: number;
  accounts: Array<{ id: string; name: string; enabled: boolean; active: number; capacity: number }>;
}

export function queueStats(jobs: Job[], accounts: Account[], perAccountConcurrency: number): QueueStats {
  const cap = clampConcurrency(perAccountConcurrency);
  const counts: Record<JobStatus, number> = { queued: 0, uploading: 0, encoding: 0, ready: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  const active = activeCounts(jobs);
  const accountsView = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    active: active.get(account.id) ?? 0,
    capacity: cap,
  }));
  return {
    counts,
    total: jobs.length,
    active: counts.uploading + counts.encoding,
    queued: counts.queued,
    capacity: accountsView.filter((account) => account.enabled).length * cap,
    perAccountConcurrency: cap,
    accounts: accountsView,
  };
}
