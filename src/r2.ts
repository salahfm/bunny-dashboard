/**
 * Cloudflare R2, over its S3-compatible API — no SDK.
 *
 * R2 is S3 with a different endpoint (`https://<account>.r2.cloudflarestorage.com`),
 * a fixed region (`auto`) and the same Signature Version 4 request signing, so
 * the whole client is a signer plus a handful of verbs. Hand-rolling it keeps the
 * dependency list what it already is (express and tsx) and keeps the one subtle
 * thing — the signature — in a file that can be checked against AWS's own
 * published test vectors, which is exactly what `tests/r2.test.ts` does.
 *
 * The upload path is the shape a video archive needs: a body is streamed in
 * once, buffered a part at a time, and sent either as one signed `PUT` (when it
 * fits) or as an S3 multipart upload (CreateMultipartUpload → UploadPart × n →
 * CompleteMultipartUpload). Multipart is what makes a multi-gigabyte MP4
 * possible without holding it in memory and without asking R2 to accept an
 * unsigned payload: every part carries its own real SHA-256. A body whose length
 * is known switches to multipart before it is read; an unknown length switches
 * the moment it outgrows a single request.
 *
 * Nothing here knows about videos or catalogues; it moves bytes to keys.
 */
import crypto from 'node:crypto';
import { NetworkError, fetchWithPolicy } from './net';

/** Any answer R2 gave that was not a success. */
export class S3Error extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'S3Error';
    if (status !== undefined) this.status = status;
  }
}

export interface R2Options {
  /** The Cloudflare account id; used to build the default endpoint. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Defaults to `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /** R2's S3 API uses `auto`; a value is kept for other S3-compatible targets. */
  region?: string;
}

/** What a HEAD tells us about an object already in the bucket. */
export interface R2ObjectInfo {
  key: string;
  bytes?: number;
  etag?: string;
  contentType?: string;
}

/** Bodies up to this size go in one signed PUT; bigger ones become multipart. */
export const SINGLE_PUT_LIMIT_BYTES = 16 * 1024 * 1024;

/** Multipart part size. S3 requires every part but the last to be at least 5 MiB. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

/** How long one transfer attempt may take (a part, or a whole small object). */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** Control-plane calls (HEAD, DELETE, create/complete) are small and quick. */
const CONTROL_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Signature Version 4                                                 */
/* ------------------------------------------------------------------ */

function hmac(key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The lowercase hex SHA-256 of a body — the payload hash S3 asks for. */
export function sha256Hex(body: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * RFC 3986 encoding: everything except `A-Za-z0-9-._~` is percent-encoded.
 *
 * `encodeURIComponent` leaves `!*'()` alone, which SigV4 does not, so those are
 * fixed up by hand. Called with `keepSlash: false` for a path segment (so a `/`
 * that separates segments survives) and `true` for a query key or value (where a
 * `/` is data and must be encoded).
 */
export function encodeRfc3986(value: string, keepSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(/[!*'()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded : encoded.replace(/%2F/gi, '/');
}

/** `YYYYMMDDTHHMMSSZ`, the timestamp SigV4 signs. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** The canonical query string: encoded, then sorted by key and value. */
export function canonicalQuery(pairs: Array<[string, string]>): string {
  return pairs
    .map(([key, value]) => [encodeRfc3986(key, true), encodeRfc3986(value, true)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Canonical headers: lowercased names, whitespace collapsed, sorted by name. */
export function canonicalHeaders(headers: Record<string, string | string[]>): { block: string; signed: string } {
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase().trim();
    if (!key) continue;
    // A repeated header (the same name twice) is one canonical entry whose
    // values are comma-joined in the order they were sent, exactly as SigV4
    // defines it.
    const joined = (Array.isArray(value) ? value : [value])
      .map((part) => String(part ?? '').trim().replace(/\s+/g, ' '))
      .join(',');
    lowered.set(key, joined);
  }
  const names = [...lowered.keys()].sort();
  const block = names.map((name) => `${name}:${lowered.get(name)}\n`).join('');
  return { block, signed: names.join(';') };
}

export interface SignatureInput {
  method: string;
  /** The request path, undecoded; each segment is encoded here. */
  path: string;
  query?: Array<[string, string]>;
  /** Headers to sign, including `host`. Case-insensitive names. An array is a repeated header. */
  headers: Record<string, string | string[]>;
  /** Lowercase hex SHA-256 of the body. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}

export interface Signature {
  /** The value of the `Authorization` header. */
  authorization: string;
  /** The three parts of the signing process, for a caller that wants to test them. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  scope: string;
  amzDate: string;
}

/**
 * One request's Signature Version 4 header.
 *
 * The four steps are the documented ones: build the canonical request, hash it,
 * build the string to sign, then derive the signing key by HMAC-ing the date, the
 * region, the service and `aws4_request` into `AWS4<secret>` in that order.
 * `tests/r2.test.ts` checks the result against AWS's published vectors, because a
 * wrong signature is a 403 that says nothing about which byte was wrong.
 */
export function signRequest(input: SignatureInput): Signature {
  const { block, signed } = canonicalHeaders(input.headers);
  const amz = amzDate(input.date);
  const scope = `${amz.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const canonicalRequest = [
    input.method.toUpperCase(),
    encodeRfc3986(input.path || '/', false),
    canonicalQuery(input.query ?? []),
    block,
    signed,
    input.payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, amz.slice(0, 8)), input.region), input.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signature,
    scope,
    amzDate: amz,
  };
}

/** The text inside the first `<Tag>…</Tag>` of an S3 XML answer. */
export function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1]?.trim() || undefined;
}

/* ------------------------------------------------------------------ */
/* The client                                                          */
/* ------------------------------------------------------------------ */

export interface R2ClientDeps extends R2Options {
  fetchImpl?: typeof fetch;
  /** Clock, injected so a signature can be pinned to a fixed instant. */
  now?: () => Date;
  /** How long one transfer attempt may take (default 10 minutes). */
  transferTimeoutMs?: number;
  /** Part size, overridable so a test can exercise multipart with small bodies. */
  partBytes?: number;
  /** Body size above which the upload becomes multipart (default [SINGLE_PUT_LIMIT_BYTES]). */
  singlePutLimitBytes?: number;
}

/** One uploaded part, as the multipart completion lists it. */
export interface R2Part {
  partNumber: number;
  etag: string;
  bytes: number;
}

export interface R2UploadResult {
  key: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the whole body, for the archive manifest. */
  sha256: string;
  /** How many parts it took; 1 means a single signed `PUT`. */
  parts: number;
  etag?: string;
}

export class R2Client {
  readonly endpoint: string;
  readonly bucket: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;
  private fetchImpl: typeof fetch;
  private now: () => Date;
  private transferTimeoutMs: number;
  private partBytes: number;
  private singlePutLimitBytes: number;
  private requestCount = 0;

  constructor(deps: R2ClientDeps) {
    this.endpoint = (deps.endpoint ?? `https://${deps.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
    this.bucket = deps.bucket;
    this.accessKeyId = deps.accessKeyId;
    this.secretAccessKey = deps.secretAccessKey;
    this.region = deps.region ?? 'auto';
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.transferTimeoutMs = deps.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    this.partBytes = Math.max(1, Math.floor(deps.partBytes ?? MULTIPART_PART_BYTES));
    this.singlePutLimitBytes = Math.max(1, Math.floor(deps.singlePutLimitBytes ?? SINGLE_PUT_LIMIT_BYTES));
  }

  /** How many requests this client has made — a test asserts on it. */
  get requests(): number {
    return this.requestCount;
  }

  /** The public URL of a key, when the bucket is served through a custom domain. */
  static publicUrl(publicBase: string | undefined, key: string): string | undefined {
    if (!publicBase) return undefined;
    return `${publicBase.replace(/\/+$/, '')}/${key.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  /** The key's URL on the S3 endpoint. An empty key is the bucket itself. */
  objectUrl(key: string): string {
    return `${this.endpoint}${this.pathFor(key)}`;
  }

  /**
   * The bucket path a key signs and requests, each segment RFC 3986-encoded.
   *
   * An empty key is the bucket root — `/<bucket>` with no trailing slash — which
   * is what `ListObjectsV2` addresses when there is no prefix to list under.
   */
  private pathFor(key: string): string {
    if (!key) return `/${this.bucket}`;
    return `/${this.bucket}/${key.split('/').map((segment) => encodeRfc3986(segment, false)).join('/')}`;
  }

  /** One signed request. `host` is signed but never sent: fetch sets its own. */
  private async send(
    method: string,
    key: string,
    options: { query?: Array<[string, string]>; headers?: Record<string, string>; body?: Buffer | string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const payload = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : options.body;
    const payloadHash = sha256Hex(payload ?? '');
    const encodedPath = this.pathFor(key);
    const date = this.now();
    const signedHeaders: Record<string, string> = {
      ...(options.headers ?? {}),
      host: new URL(this.endpoint).host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(date),
    };
    const signature = signRequest({
      method,
      path: encodedPath,
      ...(options.query?.length ? { query: options.query } : {}),
      headers: signedHeaders,
      payloadHash,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      service: 's3',
      date,
    });

    const outgoing: Record<string, string> = { ...(options.headers ?? {}), 'x-amz-content-sha256': payloadHash, 'x-amz-date': signedHeaders['x-amz-date'] as string, authorization: signature.authorization };
    if (payload) outgoing['content-length'] = String(payload.length);
    const target = options.query?.length
      ? `${this.endpoint}${encodedPath}?${options.query.map(([name, value]) => `${name}=${encodeRfc3986(value, true)}`).join('&')}`
      : `${this.endpoint}${encodedPath}`;

    this.requestCount += 1;
    let response: Response;
    try {
      response = await fetchWithPolicy(
        target,
        { method, headers: outgoing, ...(payload ? { body: payload } : {}) },
        { what: 'Cloudflare R2', fetchImpl: this.fetchImpl, timeoutMs: options.timeoutMs ?? CONTROL_TIMEOUT_MS, retries: 2, backoffMs: 700 },
      );
    } catch (error) {
      if (error instanceof NetworkError) throw new S3Error(`R2 ${method} ${key} failed: ${error.message}`, error.status);
      throw error;
    }
    if (!response.ok) throw new S3Error(await describeS3Failure(method, key, response), response.status);
    return response;
  }

  /**
   * Uploads a body, streaming it in once.
   *
   * A known `contentLength` above the single-request limit goes straight to
   * multipart; an unknown or small length is buffered until it either ends (one
   * signed `PUT`) or outgrows the limit (multipart from there on). The whole
   * body is fed through a running SHA-256 as it arrives, so the archive manifest
   * can record a hash a later reader can check against the downloaded object.
   */
  async put(
    key: string,
    source: AsyncIterable<Buffer> | Buffer | string,
    options: { contentType?: string; contentLength?: number } = {},
  ): Promise<R2UploadResult> {
    const headers: Record<string, string> = options.contentType ? { 'content-type': options.contentType } : {};
    const known = options.contentLength;

    // A declared length that cannot fit in one signed PUT needs no buffering to
    // find that out: go straight to multipart and stream the body in once.
    if (known !== undefined && known > this.singlePutLimitBytes) {
      return this.multipart(key, toChunks(source), options, crypto.createHash('sha256'), Buffer.alloc(0));
    }

    // Otherwise buffer until the body either ends (one signed PUT) or outgrows
    // the limit (multipart from there on).
    const buffers: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    if (Buffer.isBuffer(source) || typeof source === 'string') {
      const body = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
      buffers.push(body);
      bytes = body.length;
      overflow = bytes > this.singlePutLimitBytes;
    } else {
      // Stepped by hand rather than `for await`, so breaking out on overflow
      // does not call the iterator's `return()` and close the stream — the rest
      // of it still has to be read by the multipart upload.
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const { done, value } = await iterator.next();
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        buffers.push(chunk);
        bytes += chunk.length;
        if (bytes > this.singlePutLimitBytes) {
          overflow = true;
          break;
        }
      }
      if (overflow) {
        // What was read is the multipart upload's prefix; the rest of the same
        // iterator is the tail, so the stream is read exactly once.
        const prefix = Buffer.concat(buffers, bytes);
        const tail = (async function* (): AsyncIterable<Buffer> {
          for (;;) {
            const { done, value } = await iterator.next();
            if (done) return;
            yield Buffer.isBuffer(value) ? value : Buffer.from(value);
          }
        })();
        return this.multipart(key, tail, options, crypto.createHash('sha256').update(prefix), prefix);
      }
    }

    const body = Buffer.concat(buffers, bytes);
    const response = await this.send('PUT', key, { headers: { ...headers, 'content-length': String(body.length) }, body, timeoutMs: this.transferTimeoutMs });
    return { key, bytes, sha256: sha256Hex(body), parts: 1, ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}) };
  }

  /**
   * The multipart path: create, put parts as they arrive, complete (or abort).
   *
   * `prefix` is the part of the body that was already read and hashed before the
   * decision to go multipart was made (empty when the length was known up front).
   * `bytes` therefore starts at the prefix's length and only the bytes still in
   * `source` are hashed here — the prefix is hashed exactly once, by the caller.
   */
  private async multipart(
    key: string,
    source: AsyncIterable<Buffer>,
    options: { contentType?: string; contentLength?: number },
    hash: crypto.Hash,
    prefix: Buffer,
  ): Promise<R2UploadResult> {
    const created = await this.send('POST', key, {
      query: [['uploads', '']],
      headers: options.contentType ? { 'content-type': options.contentType } : {},
    });
    const uploadId = extractTag(await created.text(), 'UploadId');
    if (!uploadId) throw new S3Error(`R2 did not return an upload id for ${key}`);

    const parts: R2Part[] = [];
    const uploadPart = async (part: Buffer): Promise<void> => {
      const response = await this.send('PUT', key, {
        query: [
          ['partNumber', String(parts.length + 1)],
          ['uploadId', uploadId],
        ],
        body: part,
        timeoutMs: this.transferTimeoutMs,
      });
      const etag = response.headers.get('etag');
      if (!etag) throw new S3Error(`R2 did not return an ETag for part ${parts.length + 1} of ${key}`);
      parts.push({ partNumber: parts.length + 1, etag, bytes: part.length });
    };

    let pending = prefix;
    let bytes = prefix.length;
    const flushFullParts = async (): Promise<void> => {
      while (pending.length >= this.partBytes) {
        await uploadPart(Buffer.from(pending.subarray(0, this.partBytes)));
        pending = pending.subarray(this.partBytes);
      }
    };

    try {
      // A prefix of a single-request size can already hold whole parts.
      await flushFullParts();
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.length;
        pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
        await flushFullParts();
      }
      // S3 rejects a zero-byte final part, so an exact multiple sends nothing more.
      if (pending.length > 0 || parts.length === 0) await uploadPart(Buffer.from(pending));
    } catch (error) {
      // A half-finished upload keeps billing for its parts: abort it.
      await this.send('DELETE', key, { query: [['uploadId', uploadId]] }).catch(() => undefined);
      throw error;
    }

    const body = `<CompleteMultipartUpload>${parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    let response: Response;
    try {
      response = await this.send('POST', key, {
        query: [['uploadId', uploadId]],
        headers: { 'content-type': 'application/xml' },
        body,
      });
    } catch (error) {
      // A completion that cannot land leaves an upload whose parts keep being
      // billed for nothing: give them up rather than leave them orphaned.
      await this.send('DELETE', key, { query: [['uploadId', uploadId]] }).catch(() => undefined);
      throw error;
    }
    return {
      key,
      bytes,
      sha256: hash.digest('hex'),
      parts: parts.length,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}),
    };
  }

  /** The object's size and ETag, or undefined when it is not there. */
  async head(key: string): Promise<R2ObjectInfo | undefined> {
    let response: Response;
    try {
      response = await this.send('HEAD', key);
    } catch (error) {
      // A missing object is an answer, not a failure. A 403 is *not* treated as
      // one: it means the request was refused (a bad key, a bucket the token
      // cannot read), and reporting that as "not there" would silently make a
      // verification pass when it never actually looked.
      if (error instanceof S3Error && error.status === 404) return undefined;
      throw error;
    }
    const size = Number(response.headers.get('content-length') ?? Number.NaN);
    return {
      key,
      ...(Number.isFinite(size) ? { bytes: size } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}),
      ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type') as string } : {}),
    };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key);
  }

  /**
   * The keys under a prefix, following the continuation token.
   *
   * Used by the `verify` path and by tests; an archive run itself verifies with
   * HEAD, which is exact and does not depend on list consistency.
   */
  async list(prefix: string, limit = 1000): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const query: Array<[string, string]> = [
        ['list-type', '2'],
        ['prefix', prefix],
        ['max-keys', String(Math.min(1000, Math.max(1, limit - keys.length)))],
      ];
      if (token) query.push(['continuation-token', token]);
      const response = await this.send('GET', '', { query, timeoutMs: CONTROL_TIMEOUT_MS });
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        if (match[1] !== undefined) keys.push(decodeXml(match[1]));
      }
      token = extractTag(xml, 'NextContinuationToken');
      if (!token || keys.length >= limit) break;
    }
    return keys.length > limit ? keys.slice(0, limit) : keys;
  }
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A body, however it was given, as the chunk stream the upload paths consume. */
async function* toChunks(source: AsyncIterable<Buffer> | Buffer | string): AsyncIterable<Buffer> {
  if (Buffer.isBuffer(source) || typeof source === 'string') {
    yield Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
    return;
  }
  for await (const chunk of source) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

/** S3 says what went wrong in XML; surface its own message rather than the code. */
export async function describeS3Failure(method: string, key: string, response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    detail = extractTag(text, 'Message') ?? text.slice(0, 200);
  } catch {
    /* not every answer has a body */
  }
  const hint = response.status === 401 ? ' — check the R2 access key id and secret' : response.status === 404 ? ' — check the bucket name' : '';
  return `R2 ${method} ${key} answered HTTP ${response.status}${detail ? `: ${detail}` : hint}`;
}
