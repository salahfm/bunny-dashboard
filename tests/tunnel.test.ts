/**
 * The tunnel manager, without a tunnel.
 *
 * A real quick tunnel needs cloudflared and outbound HTTPS, neither of which a
 * test may assume. What is checked here is everything around that: the banner
 * line the public URL is read from, the external-URL mode (which is how an
 * operator points the dashboard at a tunnel they run themselves), and the two
 * failure shapes — no binary, and a binary that cannot be started.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TunnelManager, parseTunnelUrl } from '../src/tunnel';

test('the public URL is read out of cloudflared’s banner, and nothing else is', () => {
  const banner = [
    '2026-10-04T20:07:11Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account,',
    '2026-10-04T20:07:11Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-10-04T20:07:13Z INF +--------------------------------------------------------------------------------------------+',
    '2026-10-04T20:07:13Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-10-04T20:07:13Z INF |  https://brave-cat-4821.trycloudflare.com                                                  |',
    '2026-10-04T20:07:13Z INF +--------------------------------------------------------------------------------------------+',
  ];
  assert.equal(parseTunnelUrl(banner[0] ?? ''), null);
  assert.equal(parseTunnelUrl(banner[1] ?? ''), null);
  assert.equal(parseTunnelUrl(banner[4] ?? ''), 'https://brave-cat-4821.trycloudflare.com');
  // Case is normalised, so the URL can be concatenated with a path safely.
  assert.equal(parseTunnelUrl('visit HTTPS://MERRY-OTTER-99.TRYCLOUDFLARE.COM now'), 'https://merry-otter-99.trycloudflare.com');
});

test('an externally managed tunnel is used as-is and never spawned', () => {
  const manager = new TunnelManager({ root: os.tmpdir(), port: 4747, externalUrl: 'https://mine.example.com/' });
  const status = manager.status();
  assert.equal(status.state, 'running');
  assert.equal(status.url, 'https://mine.example.com');
  assert.equal(status.external, true);
});

test('without cloudflared and without permission to download, the tunnel says why', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-'));
  try {
    const manager = new TunnelManager({ root, port: 4747, enabled: true, allowDownload: false });
    const status = await manager.start();
    assert.equal(status.state, 'unavailable');
    assert.equal(status.url, null);
    assert.match(status.detail ?? '', /not installed|no cloudflared build|automatic download is off/);
    assert.equal(await manager.ensure(), null, 'a job must be told to fall back rather than hang');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cloudflared that cannot be started becomes an error, not a hang', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-'));
  try {
    const manager = new TunnelManager({
      root,
      port: 4747,
      enabled: true,
      allowDownload: false,
      binaryPath: path.join(root, 'does-not-exist', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    });
    const status = await manager.start();
    assert.equal(status.state, 'error');
    assert.match(status.detail ?? '', /could not start|exited/i);
    assert.equal(status.url, null);
    manager.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
