/**
 * A real HTTP stand-in for a bunny.net pull zone.
 *
 * A finished video's files — the per-resolution MP4 fallbacks, the thumbnails,
 * the animated previews, the seek sprites, the HLS index, the caption tracks —
 * are all plain files under `/{videoId}/…` on the account's pull zone, so this
 * serves exactly that address space from a map a test writes: any path not in
 * the map is a 404, which is how the archive is supposed to discover that an
 * asset does not exist.
 *
 * Both `HEAD` (the size probe the archive does first) and `GET` are answered, so
 * a test drives the real download path rather than a mock's idea of it.
 */
import http from 'node:http';

export interface FakePullZoneFile {
  body: Buffer | string;
  contentType?: string;
}

export interface FakePullZone {
  url: string;
  port: number;
  transcript: {
    heads: number;
    gets: number;
    /** Every path that was asked for, in order, prefixed with the method. */
    requests: string[];
  };
  /** Replaces one file mid-test (e.g. to make an asset vanish between runs). */
  set(path: string, file: FakePullZoneFile): void;
  remove(path: string): void;
  close(): Promise<void>;
}

export async function startFakePullZone(files: Record<string, FakePullZoneFile>): Promise<FakePullZone> {
  const stored = new Map<string, FakePullZoneFile>();
  for (const [key, file] of Object.entries(files)) stored.set(normalize(key), file);
  const transcript: FakePullZone['transcript'] = { heads: 0, gets: 0, requests: [] };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = normalize(decodeURIComponent(url.pathname));
    const method = (request.method ?? 'GET').toUpperCase();
    transcript.requests.push(`${method} ${key}`);
    const file = stored.get(key);
    if (!file) {
      response.writeHead(404, { 'content-length': '0' });
      response.end();
      return;
    }
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
    const headers: Record<string, string> = { 'content-length': String(body.length) };
    if (file.contentType) headers['content-type'] = file.contentType;
    if (method === 'HEAD') {
      transcript.heads += 1;
      response.writeHead(200, headers);
      response.end();
      return;
    }
    transcript.gets += 1;
    response.writeHead(200, headers);
    response.end(body);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    transcript,
    set: (path, file) => stored.set(normalize(path), file),
    remove: (path) => void stored.delete(normalize(path)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function normalize(path: string): string {
  return path.replace(/^\/+/, '');
}
