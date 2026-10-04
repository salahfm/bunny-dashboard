/**
 * A real HTTP stand-in for Bunny Stream, used by the crash-resume test.
 *
 * It speaks the small slice of the API the dashboard uses — create a video,
 * the TUS upload endpoint (create / HEAD offset / PATCH chunks), read status,
 * delete — and it keeps its state in the test process, so it outlives a
 * dashboard that is killed mid-upload.
 *
 * `configure({ stallAfterPatches, partialBytes })` makes the next PATCH store
 * only part of its body and never answer, which is what a dropped connection
 * mid-chunk looks like from the uploader's side. The bytes it did store stay in
 * the session, so a restarted dashboard must resume from that exact offset.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export interface FakeBunnyPatch {
  offset: number;
  bytes: number;
  complete: boolean;
}

export interface FakeBunnySession {
  id: string;
  videoId: string;
  length: number;
  offset: number;
  stored: Buffer;
}

interface Stall {
  stallAfterPatches: number;
  partialBytes: number;
  fired: boolean;
  partialStored: boolean;
}

export interface FakeBunny {
  url: string;
  port: number;
  transcript: {
    videoCreates: number;
    tusCreates: number;
    heads: number;
    /** Every PATCH the server saw, in order, complete or not. */
    patchOffsets: number[];
    patches: FakeBunnyPatch[];
    deletes: number;
    /** True once a stalled PATCH stored its partial bytes. */
    partialStored: boolean;
  };
  sessions(): FakeBunnySession[];
  configure(options: { stallAfterPatches: number; partialBytes: number }): void;
  close(): Promise<void>;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

export async function startFakeBunny(): Promise<FakeBunny> {
  const sessions = new Map<string, FakeBunnySession>();
  const byVideoId = new Map<string, string>();
  const videos = new Map<string, { title: string }>();
  let stall: Stall | undefined;
  const transcript: FakeBunny['transcript'] = { videoCreates: 0, tusCreates: 0, heads: 0, patchOffsets: [], patches: [], deletes: 0, partialStored: false };

  let base = '';
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const method = (request.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;

    /* ---------------------------- TUS ---------------------------- */
    if (method === 'POST' && pathname === '/tusupload') {
      const videoId = String(request.headers.videoid ?? '');
      const length = Number(request.headers['upload-length'] ?? 0);
      transcript.tusCreates += 1;
      const existingId = byVideoId.get(videoId);
      const existing = existingId ? sessions.get(existingId) : undefined;
      const session: FakeBunnySession =
        existing && existing.length === length
          ? existing
          : { id: `s${sessions.size + 1}-${crypto.randomUUID().slice(0, 8)}`, videoId, length, offset: 0, stored: Buffer.alloc(length) };
      sessions.set(session.id, session);
      byVideoId.set(videoId, session.id);
      response.writeHead(201, {
        Location: `${base}/tusupload/${session.id}`,
        'Upload-Offset': String(session.offset),
        'Tus-Resumable': '1.0.0',
      });
      response.end();
      return;
    }

    const tusMatch = pathname.match(/^\/tusupload\/(.+)$/);
    if (tusMatch?.[1]) {
      const session = sessions.get(decodeURIComponent(tusMatch[1]));
      if (!session) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (method === 'HEAD') {
        transcript.heads += 1;
        response.writeHead(200, {
          'Upload-Offset': String(session.offset),
          'Upload-Length': String(session.length),
          'Tus-Resumable': '1.0.0',
        });
        response.end();
        return;
      }
      if (method === 'PATCH') {
        const offset = Number(request.headers['upload-offset']);
        const body = await readBody(request);
        transcript.patchOffsets.push(offset);
        const attempt = transcript.patchOffsets.length;
        if (stall && !stall.fired && attempt === stall.stallAfterPatches + 1) {
          stall.fired = true;
          const keep = Math.min(stall.partialBytes, body.length);
          body.copy(session.stored, offset);
          session.offset = offset + keep;
          stall.partialStored = true;
          transcript.partialStored = true;
          // Never answer: the dashboard is killed with this request in flight,
          // exactly like a connection that dies mid-chunk.
          return;
        }
        if (offset !== session.offset) {
          response.writeHead(409, { 'Upload-Offset': String(session.offset) });
          response.end();
          return;
        }
        body.copy(session.stored, offset);
        session.offset = offset + body.length;
        transcript.patches.push({ offset, bytes: body.length, complete: true });
        response.writeHead(204, { 'Upload-Offset': String(session.offset), 'Tus-Resumable': '1.0.0' });
        response.end();
        return;
      }
    }

    /* ---------------------------- REST ---------------------------- */
    const libraryMatch = pathname.match(/^\/library\/([^/]+)\/videos(?:\/([^/]+))?$/);
    if (libraryMatch) {
      const videoId = libraryMatch[2] ? decodeURIComponent(libraryMatch[2]) : undefined;
      if (method === 'POST' && !videoId) {
        const body = await readBody(request);
        const title = (() => {
          try {
            return (JSON.parse(body.toString('utf8')) as { title?: string }).title ?? 'untitled';
          } catch {
            return 'untitled';
          }
        })();
        const guid = crypto.randomUUID();
        videos.set(guid, { title });
        transcript.videoCreates += 1;
        json(response, 200, { guid, title, status: 0, encodeProgress: 0, length: 0 });
        return;
      }
      if (videoId && method === 'GET') {
        const sessionId = byVideoId.get(videoId);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const complete = Boolean(session && session.length > 0 && session.offset >= session.length);
        json(response, 200, {
          guid: videoId,
          title: videos.get(videoId)?.title ?? 'untitled',
          status: complete ? 4 : 3,
          encodeProgress: complete ? 100 : Math.round(((session?.offset ?? 0) / (session?.length || 1)) * 100),
          length: 90,
        });
        return;
      }
      if (videoId && method === 'DELETE') {
        transcript.deletes += 1;
        response.writeHead(200);
        response.end();
        return;
      }
    }

    if (pathname.endsWith('/videos/fetch') && method === 'POST') {
      json(response, 200, { success: true, statusCode: 200, message: 'OK' });
      return;
    }
    json(response, 404, { error: `the fake Bunny does not know ${method} ${pathname}` });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    port,
    transcript,
    sessions: () => [...sessions.values()].map((session) => ({ ...session, stored: Buffer.from(session.stored) })),
    configure: (options) => {
      stall = { ...options, fired: false, partialStored: false };
      transcript.partialStored = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
