/**
 * The heaviest test in the suite: it runs the real dashboard as a child
 * process, kills it with SIGKILL while a TUS chunk is in flight, starts it
 * again over the same data directory, and proves the upload continues at the
 * offset the fake Bunny already holds — not from zero.
 *
 * The Bunny stand-in lives in this process (so it survives the kill), and the
 * child reaches it through `tests/support/bunny-redirect.ts`, which rewrites
 * Bunny's public base URL. No production code is aware of any of this.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startFakeBunny } from './support/fake-bunny';

const CHUNK = 64 * 1024;
const ROOT = path.resolve(import.meta.dirname, '..');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startDashboard(port: number, dataDir: string, fakeBunnyUrl: string, logs: { text: string }): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      // A file:// URL, because a bare Windows path would be read as a URL scheme.
      '--import',
      pathToFileURL(path.join(ROOT, 'tests/support/bunny-redirect.ts')).href,
      path.join(ROOT, 'src/server.ts'),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: dataDir,
        FAKE_BUNNY_URL: fakeBunnyUrl,
        UPLOAD_MODE: 'tus',
        TUS_CHUNK_BYTES: String(CHUNK),
        TICK_INTERVAL_MS: '100',
        POLL_INTERVAL_MS: '500',
        MOCK_PROVIDERS: '0',
        WATCH_DIR: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    logs.text += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logs.text += chunk.toString('utf8');
  });
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await Promise.race([exited, sleep(10_000)]);
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`the dashboard on port ${port} did not answer in time`);
    await sleep(100);
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

async function jobStatus(port: number, jobId: string): Promise<{ status: string; error?: string } | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs?limit=50`);
  const body = (await response.json()) as { jobs?: Array<{ id: string; status: string; error?: string }> };
  return body.jobs?.find((job) => job.id === jobId);
}

test('a dashboard killed mid-upload resumes from Bunny’s offset, not from zero', { timeout: 120_000 }, async () => {
  const bunny = await startFakeBunny();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-resume-data-'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-resume-src-'));
  const source = path.join(sourceDir, 'movie.bin');
  const bytes = Buffer.alloc(4 * CHUNK);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 13 + 5) % 251;
  fs.writeFileSync(source, bytes);

  const port = await freePort();
  const partialBytes = 24 * 1024;
  const partialOffset = CHUNK + partialBytes; // 88064: not a chunk boundary
  const logs = { text: '' };
  let child: ChildProcess | undefined;

  try {
    // The second chunk is dropped mid-transfer; the kill happens while that
    // request is still open.
    bunny.configure({ stallAfterPatches: 1, partialBytes });

    child = startDashboard(port, dataDir, bunny.url, logs);
    await waitForHealth(port);

    const accountResponse = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'crash-test', libraryId: '777', apiKey: 'test-key-1234' }),
    });
    assert.equal(accountResponse.status, 201, `creating the account returned ${accountResponse.status}`);

    const target = { kind: 'movie', tmdbId: 27205, title: 'Inception', year: '2010' };
    const uploadResponse = await fetch(
      `http://127.0.0.1:${port}/api/jobs/upload?meta=${encodeURIComponent(JSON.stringify(target))}&name=movie.bin`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes },
    );
    assert.equal(uploadResponse.status, 201, `creating the job returned ${uploadResponse.status}`);
    const { job } = (await uploadResponse.json()) as { job: { id: string } };

    await waitUntil(() => bunny.transcript.partialStored, 'the dropped chunk to land partially');
    assert.deepEqual(bunny.transcript.patchOffsets, [0, CHUNK], 'one complete chunk and one dropped one');
    assert.equal(bunny.sessions()[0]?.offset, partialOffset, 'Bunny holds the partial bytes');

    // Everything a restart needs must already be on disk.
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')) as {
      jobs: Array<{ id: string; status: string; bunnyVideoId?: string; tusUploadUrl?: string; resumeAccountId?: string; accountId?: string; source: { tempPath?: string } }>;
    };
    const stored = db.jobs.find((entry) => entry.id === job.id);
    assert.ok(stored, 'the job is in the store');
    assert.equal(stored.status, 'uploading', 'the job is mid-upload when the process dies');
    assert.equal(typeof stored.bunnyVideoId, 'string', 'the Bunny video object is remembered');
    assert.equal(typeof stored.tusUploadUrl, 'string', 'the TUS session URL is remembered');
    assert.equal(stored.resumeAccountId, stored.accountId, 'the session is pinned to its account');
    const tempPath = stored.source.tempPath;
    assert.ok(tempPath, 'the job points at its temp file');

    await kill(child);
    child = undefined;
    assert.equal(fs.existsSync(tempPath), true, 'the temp file survives the crash');

    // A fresh process over the same data directory — the Bunny stand-in never stopped.
    child = startDashboard(port, dataDir, bunny.url, logs);
    await waitForHealth(port);

    await waitUntil(() => bunny.transcript.patchOffsets.length > 2, 'the resumed upload to send a chunk');
    assert.equal(
      bunny.transcript.patchOffsets[2],
      partialOffset,
      `the upload must resume at Bunny’s ${partialOffset} bytes, not at a chunk boundary or zero`,
    );
    assert.equal(bunny.transcript.tusCreates, 1, 'the restarted dashboard reuses the existing TUS session');
    assert.equal(bunny.transcript.videoCreates, 1, 'the restarted dashboard reuses the same Bunny video object');

    await waitUntil(async () => (await jobStatus(port, job.id))?.status === 'ready', 'the job to finish after the resume');
    const sessions = bunny.sessions();
    assert.equal(sessions.length, 1, 'only one upload session was ever created');
    assert.equal(sessions[0]?.offset, bytes.length);
    assert.ok(sessions[0]?.stored.equals(bytes), 'the bytes Bunny ended up with must match the source file exactly');
    assert.equal(fs.existsSync(tempPath), false, 'the temp file is cleaned up once the job is ready');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${logs.text ? `\n--- dashboard output ---\n${logs.text}` : ''}`);
  } finally {
    if (child) await kill(child);
    await bunny.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});
