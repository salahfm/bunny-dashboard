import assert from 'node:assert/strict';
import test from 'node:test';
import { planAssignments, queueStats } from '../src/queue';
import type { Account, Job, JobStatus } from '../src/store';

function makeAccount(id: string, enabled = true): Account {
  return { id, name: id, libraryId: '1', apiKeyEnc: 'x', enabled, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

function makeJob(id: string, status: JobStatus, createdAt: string, accountId?: string): Job {
  const job: Job = {
    id,
    target: { kind: 'movie', tmdbId: 1, title: 'Test' },
    source: { kind: 'url', name: 'test.mp4', url: 'https://example.com/test.mp4' },
    status,
    progress: 0,
    polls: 0,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  if (accountId) job.accountId = accountId;
  return job;
}

test('one account starts at most 10 uploads at once', () => {
  const accounts = [makeAccount('a')];
  const jobs = Array.from({ length: 25 }, (_, index) => makeJob(`j${index}`, 'queued', `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`));
  assert.equal(planAssignments(jobs, accounts, 10).length, 10);
});

test('the per-account cap is hard-capped at 10 even when asked for more', () => {
  const accounts = [makeAccount('a')];
  const jobs = Array.from({ length: 25 }, (_, index) => makeJob(`j${index}`, 'queued', `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`));
  assert.equal(planAssignments(jobs, accounts, 50).length, 10);
});

test('queued jobs spread evenly across accounts, oldest first', () => {
  const accounts = [makeAccount('a'), makeAccount('b'), makeAccount('c')];
  const jobs = Array.from({ length: 60 }, (_, index) => makeJob(`j${index}`, 'queued', `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`));
  const assignments = planAssignments(jobs, accounts, 10);
  assert.equal(assignments.length, 30);
  const perAccount = new Map<string, number>();
  for (const assignment of assignments) perAccount.set(assignment.accountId, (perAccount.get(assignment.accountId) ?? 0) + 1);
  assert.deepEqual([...perAccount.values()].sort((a, b) => a - b), [10, 10, 10]);
  assert.equal(assignments[0]?.jobId, 'j0');
});

test('jobs already running count against their account capacity', () => {
  const accounts = [makeAccount('a')];
  const jobs = [
    ...Array.from({ length: 7 }, (_, index) => makeJob(`active${index}`, 'encoding', `2026-01-01T00:00:0${index}.000Z`, 'a')),
    ...Array.from({ length: 10 }, (_, index) => makeJob(`queued${index}`, 'queued', `2026-01-01T00:01:0${index}.000Z`)),
  ];
  assert.equal(planAssignments(jobs, accounts, 10).length, 3);
});

test('disabled accounts receive nothing', () => {
  const accounts = [makeAccount('a', false), makeAccount('b')];
  const jobs = Array.from({ length: 5 }, (_, index) => makeJob(`j${index}`, 'queued', `2026-01-01T00:00:0${index}.000Z`));
  const assignments = planAssignments(jobs, accounts, 10);
  assert.equal(assignments.length, 5);
  assert.ok(assignments.every((assignment) => assignment.accountId === 'b'));
});

test('a job with a Bunny upload session keeps its account so it can resume', () => {
  const accounts = [makeAccount('a'), makeAccount('b')];
  const resuming = makeJob('r', 'queued', '2026-01-01T00:00:00.000Z', 'b');
  resuming.tusUploadUrl = 'https://video.bunnycdn.com/tusupload/u1';
  resuming.resumeAccountId = 'b';
  const others = [
    makeJob('x', 'queued', '2026-01-01T00:00:01.000Z'),
    makeJob('y', 'queued', '2026-01-01T00:00:02.000Z'),
    makeJob('z', 'queued', '2026-01-01T00:00:03.000Z'),
  ];

  const assignments = planAssignments([resuming, ...others], accounts, 10);

  assert.equal(assignments.find((assignment) => assignment.jobId === 'r')?.accountId, 'b');
  assert.equal(assignments.length, 4);
});

test('a resume whose account is out of capacity is reassigned to another one', () => {
  const accounts = [makeAccount('a'), makeAccount('b')];
  const busy = Array.from({ length: 10 }, (_, index) => makeJob(`busy${index}`, 'encoding', `2026-01-01T00:00:0${index}.000Z`, 'b'));
  const resuming = makeJob('r', 'queued', '2026-01-01T00:00:20.000Z', 'b');
  resuming.tusUploadUrl = 'https://video.bunnycdn.com/tusupload/u1';
  resuming.resumeAccountId = 'b';

  const assignments = planAssignments([...busy, resuming], accounts, 10);

  assert.equal(assignments.find((assignment) => assignment.jobId === 'r')?.accountId, 'a');
});

test('queueStats reports counts, usage and enabled capacity', () => {
  const accounts = [makeAccount('a'), makeAccount('b', false)];
  const jobs = [makeJob('q', 'queued', '2026-01-01T00:00:00.000Z'), makeJob('e', 'encoding', '2026-01-01T00:00:01.000Z', 'a')];
  const stats = queueStats(jobs, accounts, 10);
  assert.equal(stats.counts.queued, 1);
  assert.equal(stats.counts.encoding, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.capacity, 10);
  assert.equal(stats.accounts.find((entry) => entry.id === 'a')?.active, 1);
});
