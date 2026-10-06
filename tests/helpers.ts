import path from 'node:path';
import type { AppConfig } from '../src/config';
import { RelayHub } from '../src/relay';
import { DEFAULT_TUS_CHUNK_BYTES } from '../src/tus';
import { TunnelManager } from '../src/tunnel';

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    root: dataDir,
    port: 0,
    host: '127.0.0.1',
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    dbPath: path.join(dataDir, 'db.json'),
    secretPath: path.join(dataDir, '.secret'),
    publicDir: path.join(dataDir, 'public'),
    mock: true,
    uploadMode: 'tus',
    tusChunkBytes: DEFAULT_TUS_CHUNK_BYTES,
    watchIntervalMs: 15_000,
    watchMinAgeMs: 30_000,
    maxAccounts: 30,
    perAccountConcurrency: 10,
    tickIntervalMs: 5,
    pollIntervalMs: 5,
    maxPollsPerJob: 10,
    streamConcurrency: 2,
    tunnelEnabled: false,
    tunnelDownload: false,
    networkTimeoutMs: 30_000,
    networkRetries: 3,
    scrapeMinIntervalMs: 0,
    scrapeCooldownMs: 60_000,
    scrapeEgress: {},
    subtitleUpload: true,
    subtitleTargetLanguages: ['ar'],
    // On by default like the real configuration; a test that cares points the
    // endpoint at its own fake DeepL.
    subtitleTranslate: true,
    ...overrides,
  };
}

/**
 * A relay and a tunnel that never leaves the machine: tests must not spawn
 * cloudflared or reach the network through one.
 */
export function testStreamDeps(root: string): { relay: RelayHub; tunnel: TunnelManager } {
  return { relay: new RelayHub(), tunnel: new TunnelManager({ root, port: 0, enabled: false, allowDownload: false }) };
}

export async function waitFor(check: () => boolean, label = 'condition', timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
