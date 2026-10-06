/**
 * A real HTTP stand-in for Cloudflare R2's S3 API, used by the R2 client tests
 * and by the archive tests.
 *
 * It implements the small slice of S3 the dashboard uses — single `PUT`,
 * CreateMultipartUpload / UploadPart / CompleteMultipartUpload /
 * AbortMultipartUpload, `HEAD`, `DELETE`, `ListObjectsV2` — and keeps the
 * objects it was given in memory, so a test can assert on exactly what arrived
 * (the bytes, the content type, the part count, the signed requests) rather
 * than on a mock's idea of them.
 *
 * `failNextPart()` / `failNextComplete()` / `failNextPut()` make the next call
 * of that kind answer `500`, which is what a test needs to see an aborted
 * multipart upload or a failed archive.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export interface FakeR2Object {
  key: string;
  body: Buffer;
  contentType?: string;
  etag: string;
}

export interface FakeR2Request {
  method: string;
  key: string;
  query: string;
  authorization?: string;
}

export interface FakeR2 {
  url: string;
  port: number;
  bucket: string;
  transcript: {
    puts: number;
    multipartCreates: number;
    partUploads: number;
    completes: number;
    aborts: number;
    heads: number;
    gets: number;
    deletes: number;
    lists: number;
    requests: FakeR2Request[];
  };
  objects(): Map<string, FakeR2Object>;
  /**
   * Replaces an object's bytes in place, so a test can watch a verification pass
   * notice that what is stored no longer hashes to what the manifest recorded.
   * Returns false when the key was not there to begin with.
   */
  tamper(key: string, body: Buffer | string): boolean;
  /** Make the next `count` part uploads answer `status` (default 500). */
  failParts(count?: number, status?: number): void;
  /** Make the next `count` completion calls answer `status` (default 500). */
  failComplete(count?: number, status?: number): void;
  /** Make the next `count` single `PUT`s answer `status` (default 500). */
  failPuts(count?: number, status?: number): void;
  /** Make the next `count` `HEAD`s answer `status` (default 500). */
  failHeads(count?: number, status?: number): void;
  /** Make the next `count` object `GET`s answer `status` (default 500). */
  failGets(count?: number, status?: number): void;
  close(): Promise<void>;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function xml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function md5(buffer: Buffer): string {
  return `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;
}

export async function startFakeR2(bucket = 'archive'): Promise<FakeR2> {
  const objects = new Map<string, FakeR2Object>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  let failPart = 0;
  let failPartStatus = 500;
  let failCompleteCount = 0;
  let failCompleteStatus = 500;
  let failPut = 0;
  let failPutStatus = 500;
  let failHead = 0;
  let failHeadStatus = 500;
  let failGet = 0;
  let failGetStatus = 500;
  const transcript: FakeR2['transcript'] = {
    puts: 0,
    multipartCreates: 0,
    partUploads: 0,
    completes: 0,
    aborts: 0,
    heads: 0,
    gets: 0,
    deletes: 0,
    lists: 0,
    requests: [],
  };

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = (request.method ?? 'GET').toUpperCase();
    const rest = url.pathname.replace(/^\/+/, '');
    const slash = rest.indexOf('/');
    const requestBucket = slash < 0 ? rest : rest.slice(0, slash);
    const key = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1));
    transcript.requests.push({ method, key, query: url.search, authorization: request.headers.authorization });

    if (requestBucket !== bucket) {
      xml(response, 404, '<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }

    const uploadId = url.searchParams.get('uploadId');
    const partNumber = url.searchParams.get('partNumber');
    const isCreate = url.searchParams.has('uploads');
    const isComplete = url.searchParams.has('uploadId');
    const isList = url.searchParams.get('list-type') === '2';

    /* ----------------------------- multipart ----------------------------- */

    if (method === 'POST' && isCreate) {
      transcript.multipartCreates += 1;
      const id = `upload-${transcript.multipartCreates}`;
      uploads.set(id, { key, parts: new Map() });
      xml(response, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }

    if (method === 'PUT' && partNumber && uploadId) {
      transcript.partUploads += 1;
      if (failPart > 0) {
        failPart -= 1;
        xml(response, failPartStatus, '<Error><Code>InternalError</Code><Message>part failed</Message></Error>');
        return;
      }
      const upload = uploads.get(uploadId);
      if (!upload) {
        xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const body = await readBody(request);
      upload.parts.set(Number(partNumber), body);
      response.writeHead(200, { etag: md5(body) });
      response.end();
      return;
    }

    if (method === 'POST' && isComplete) {
      transcript.completes += 1;
      if (failCompleteCount > 0) {
        failCompleteCount -= 1;
        xml(response, failCompleteStatus, '<Error><Code>InternalError</Code><Message>complete failed</Message></Error>');
        return;
      }
      const upload = uploads.get(uploadId as string);
      if (!upload) {
        xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const parts = [...upload.parts.keys()].sort((a, b) => a - b).map((number) => upload.parts.get(number) as Buffer);
      const body = Buffer.concat(parts);
      const etag = md5(body);
      objects.set(upload.key, { key: upload.key, body, etag });
      uploads.delete(uploadId as string);
      xml(response, 200, `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
      return;
    }

    if (method === 'DELETE' && isComplete) {
      transcript.aborts += 1;
      uploads.delete(uploadId as string);
      response.writeHead(204);
      response.end();
      return;
    }

    /* ------------------------------- objects ------------------------------- */

    if (method === 'PUT') {
      if (failPut > 0) {
        failPut -= 1;
        xml(response, failPutStatus, '<Error><Code>InternalError</Code><Message>put failed</Message></Error>');
        return;
      }
      transcript.puts += 1;
      const body = await readBody(request);
      const contentType = request.headers['content-type'] ? String(request.headers['content-type']) : undefined;
      objects.set(key, { key, body, etag: md5(body), ...(contentType ? { contentType } : {}) });
      response.writeHead(200, { etag: md5(body) });
      response.end();
      return;
    }

    if (method === 'HEAD') {
      transcript.heads += 1;
      if (failHead > 0) {
        failHead -= 1;
        xml(response, failHeadStatus, '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>');
        return;
      }
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-length': String(object.body.length),
        etag: object.etag,
        ...(object.contentType ? { 'content-type': object.contentType } : {}),
      });
      response.end();
      return;
    }

    if (method === 'GET' && isList) {
      transcript.lists += 1;
      const prefix = url.searchParams.get('prefix') ?? '';
      const matched = [...objects.keys()].filter((name) => name.startsWith(prefix));
      const contents = matched.map((name) => `<Contents><Key>${name}</Key></Contents>`).join('');
      xml(response, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      return;
    }

    if (method === 'DELETE') {
      transcript.deletes += 1;
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === 'GET') {
      transcript.gets += 1;
      if (failGet > 0) {
        failGet -= 1;
        xml(response, failGetStatus, '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>');
        return;
      }
      const object = objects.get(key);
      if (!object) {
        xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'content-length': String(object.body.length), etag: object.etag });
      response.end(object.body);
      return;
    }

    xml(response, 400, '<Error><Code>BadRequest</Code></Error>');
  }

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
    bucket,
    transcript,
    objects: () => new Map([...objects.entries()]),
    tamper: (key: string, body: Buffer | string) => {
      const object = objects.get(key);
      if (!object) return false;
      const next = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      objects.set(key, { ...object, body: next, etag: md5(next) });
      return true;
    },
    failParts: (count = 1, status = 500) => {
      failPart = count;
      failPartStatus = status;
    },
    failComplete: (count = 1, status = 500) => {
      failCompleteCount = count;
      failCompleteStatus = status;
    },
    failPuts: (count = 1, status = 500) => {
      failPut = count;
      failPutStatus = status;
    },
    failHeads: (count = 1, status = 500) => {
      failHead = count;
      failHeadStatus = status;
    },
    failGets: (count = 1, status = 500) => {
      failGet = count;
      failGetStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
