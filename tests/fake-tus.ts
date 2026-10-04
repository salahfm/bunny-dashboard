/**
 * An in-memory stand-in for Bunny's TUS endpoint, so the uploader can be
 * driven through retries, partial writes and resumes without credentials.
 */

export interface FakeTusResource {
  id: string;
  videoId: string;
  length: number;
  offset: number;
  stored: Buffer;
}

function normalizeHeaders(headers: RequestInit['headers'] | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const key = entry[0];
      if (key === undefined) continue;
      normalized[key.toLowerCase()] = String(entry[1] ?? '');
    }
    return normalized;
  }
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  return normalized;
}

export class FakeTusServer {
  readonly endpoint = 'https://video.bunnycdn.com/tusupload';
  readonly resources = new Map<string, FakeTusResource>();
  private byVideoId = new Map<string, string>();
  private counter = 0;

  /** Sessions created (a resumed upload should not add another one). */
  creations = 0;
  posts = 0;
  heads = 0;
  /** Every chunk request that arrived, successful or not. */
  patchAttempts = 0;
  /** Chunk requests the server accepted, with the offset they carried. */
  patches: Array<{ offset: number; bytes: number }> = [];
  /** The next N chunk requests die before reaching the server. */
  failNextPatches = 0;
  /** Every chunk request after the first N successful ones dies. */
  failPatchesAfter = Number.POSITIVE_INFINITY;
  /** Store the first N bytes of the next chunk and drop the connection. */
  dropNextChunkBytes = 0;
  /** Status for POST (session creation); 404/401 simulate a deleted video or a bad key. */
  createStatus = 201;
  lastPostHeaders: Record<string, string> = {};

  handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const pathname = new URL(raw).pathname;

    if (method === 'POST') {
      return this.create(headers);
    }
    if (method === 'HEAD' || method === 'PATCH') {
      const id = pathname.replace(/^.*\/tusupload\/?/, '');
      const resource = id ? this.resources.get(id) : undefined;
      if (!resource) return new Response('the upload session is gone', { status: 404 });
      if (method === 'HEAD') {
        this.heads += 1;
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(resource.offset), 'Upload-Length': String(resource.length), 'Tus-Resumable': '1.0.0' },
        });
      }
      return this.patch(resource, headers, init?.body);
    }
    return new Response('method not allowed', { status: 405 });
  };

  onlyResource(): FakeTusResource {
    const [only] = [...this.resources.values()];
    if (!only || this.resources.size !== 1) throw new Error(`expected exactly one upload session, found ${this.resources.size}`);
    return only;
  }

  private create(headers: Record<string, string>): Response {
    this.posts += 1;
    this.lastPostHeaders = headers;
    if (this.createStatus !== 201) return new Response('nope', { status: this.createStatus });
    this.creations += 1;
    const videoId = headers.videoid ?? '';
    const length = Number(headers['upload-length'] ?? 0);
    const existingId = this.byVideoId.get(videoId);
    const existing = existingId ? this.resources.get(existingId) : undefined;
    const resource =
      existing && existing.length === length
        ? existing
        : { id: `u${++this.counter}`, videoId, length, offset: 0, stored: Buffer.alloc(length) };
    this.resources.set(resource.id, resource);
    this.byVideoId.set(videoId, resource.id);
    return new Response(null, {
      status: 201,
      headers: {
        Location: `/tusupload/${resource.id}`,
        'Upload-Offset': String(resource.offset),
        'Tus-Resumable': '1.0.0',
      },
    });
  }

  private patch(resource: FakeTusResource, headers: Record<string, string>, body: unknown): Response {
    this.patchAttempts += 1;
    const offset = Number(headers['upload-offset']);
    const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
    if (offset !== resource.offset) return new Response('offset conflict', { status: 409 });
    if (this.patches.length >= this.failPatchesAfter || this.failNextPatches > 0) {
      if (this.failNextPatches > 0) this.failNextPatches -= 1;
      throw new Error('socket hang up');
    }
    if (this.dropNextChunkBytes > 0) {
      const keep = Math.min(this.dropNextChunkBytes, chunk.length);
      this.dropNextChunkBytes = 0;
      resource.stored.set(chunk.subarray(0, keep), offset);
      resource.offset = offset + keep;
      throw new Error('connection reset by peer');
    }
    resource.stored.set(chunk, offset);
    resource.offset = offset + chunk.length;
    this.patches.push({ offset, bytes: chunk.length });
    return new Response(null, { status: 204, headers: { 'Upload-Offset': String(resource.offset), 'Tus-Resumable': '1.0.0' } });
  }
}
