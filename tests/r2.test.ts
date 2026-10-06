/**
 * The R2 client, checked two ways.
 *
 * First against AWS's own Signature Version 4 test vectors: the signature is
 * the one part of this file that fails opaquely (R2 answers 403 and says
 * nothing about which byte was wrong), so it is pinned to published
 * request/signature pairs rather than to whatever this implementation happens
 * to produce.
 *
 * Then against a real HTTP server standing in for R2, which exercises the
 * paths a fake client cannot: a single signed PUT, a multipart upload that
 * streams a body in once, the mid-stream switch from one to the other with an
 * unknown length, HEAD/DELETE/ListObjectsV2, and the abort that has to follow a
 * failed part.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  MULTIPART_PART_BYTES,
  SINGLE_PUT_LIMIT_BYTES,
  R2Client,
  canonicalHeaders,
  canonicalQuery,
  encodeRfc3986,
  extractTag,
  sha256Hex,
  signRequest,
  type R2ClientDeps,
} from '../src/r2';
import { startFakeR2 } from './support/fake-r2';

function sha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const EMPTY_HASH = sha('');
const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
};

interface Vector {
  name: string;
  method: string;
  path: string;
  query?: Array<[string, string]>;
  headers: Record<string, string | string[]>;
  body?: string;
  /** The canonical request, string-to-sign and signature AWS published. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const VECTORS: Vector[] = [
  {
    name: 'get-vanilla',
    method: 'GET',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63`,
    signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  },
  {
    name: 'post-x-www-form-urlencoded',
    method: 'POST',
    path: '/',
    // The suite's published `creq` for this one case disagrees with its own
    // `authz`/`sts` (it lists `content-length` as signed); the signature and
    // string-to-sign below are the official ones, whose signed headers are
    // `content-type;host;x-amz-date`.
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'example.amazonaws.com',
      'x-amz-date': '20150830T123600Z',
    },
    body: 'Param1=value1',
    canonicalRequest: `POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n42a5e5bb34198acb3e84da4f085bb7927f2bc277ca766e6d19c73c2154021281`,
    signature: 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
  },
  {
    name: 'get-header-key-duplicate',
    method: 'GET',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'my-header1': ['value2', 'value2', 'value1'], 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value2,value2,value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c`,
    signature: 'c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea',
  },
  {
    name: 'get-vanilla-query-order-key-case',
    method: 'GET',
    path: '/',
    query: [
      ['Param2', 'value2'],
      ['Param1', 'value1'],
    ],
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0`,
    signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
  },
  {
    name: 'get-unreserved',
    method: 'GET',
    path: '/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `GET\n/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n6a968768eefaa713e2a6b16b589a8ea192661f098f37349f4e2c0082757446f9`,
    signature: '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
  },
  {
    name: 'get-vanilla-utf8-query',
    method: 'GET',
    path: '/',
    query: [['ሴ', 'bar']],
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `GET\n/\n%E1%88%B4=bar\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\neb30c5bed55734080471a834cc727ae56beb50e5f39d1bff6d0d38cb192a7073`,
    signature: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04',
  },
  {
    name: 'post-header-key-case',
    method: 'POST',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87`,
    signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
  },
  {
    name: 'post-header-key-sort',
    method: 'POST',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'my-header1': 'value1', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9368318c2967cf6de74404b30c65a91e8f6253e0a8659d6d5319f1a812f87d65`,
    signature: 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c',
  },
  {
    name: 'post-header-value-case',
    method: 'POST',
    path: '/',
    headers: { host: 'example.amazonaws.com', 'my-header1': 'VALUE1', 'x-amz-date': '20150830T123600Z' },
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nmy-header1:VALUE1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\n${EMPTY_HASH}`,
    stringToSign: `AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nd51ced243e649e3de6ef63afbbdcbca03131a21a7103a1583706a64618606a93`,
    signature: 'cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d',
  },
];

for (const vector of VECTORS) {
  test(`signRequest reproduces AWS's ${vector.name} vector`, () => {
    const result = signRequest({
      method: vector.method,
      path: vector.path,
      ...(vector.query ? { query: vector.query } : {}),
      headers: vector.headers,
      payloadHash: sha(vector.body ?? ''),
      accessKeyId: VECTOR.accessKeyId,
      secretAccessKey: VECTOR.secretAccessKey,
      region: VECTOR.region,
      service: VECTOR.service,
      date: VECTOR.date,
    });
    assert.equal(result.canonicalRequest, vector.canonicalRequest, 'canonical request');
    assert.equal(result.stringToSign, vector.stringToSign, 'string to sign');
    assert.equal(result.signature, vector.signature, 'signature');
    assert.equal(result.scope, '20150830/us-east-1/service/aws4_request');
    assert.equal(result.amzDate, '20150830T123600Z');
    assert.ok(result.authorization.endsWith(`Signature=${vector.signature}`), result.authorization);
  });
}

/* ------------------------------------------------------------------ */
/* The small pieces the signer is built from                           */
/* ------------------------------------------------------------------ */

test('encodeRfc3986 escapes what encodeURIComponent leaves behind', () => {
  // SigV4's unreserved set is A-Za-z0-9-._~ and nothing else.
  assert.equal(encodeRfc3986('a b/c', false), 'a%20b/c');
  assert.equal(encodeRfc3986("!*'()", true), '%21%2A%27%28%29');
  assert.equal(encodeRfc3986('a/b', true), 'a%2Fb');
  assert.equal(encodeRfc3986('-._~', true), '-._~');
});

test('canonicalQuery sorts by key and then by value, and joins repeated headers', () => {
  assert.equal(
    canonicalQuery([
      ['b', '2'],
      ['a', 'z'],
      ['a', 'a'],
    ]),
    'a=a&a=z&b=2',
  );
  const { block, signed } = canonicalHeaders({ 'X-Amz-Date': 'x', Host: ' h  h ', 'My': ['1', '2'] });
  assert.equal(signed, 'host;my;x-amz-date');
  assert.equal(block, 'host:h h\nmy:1,2\nx-amz-date:x\n');
});

test('extractTag reads the first occurrence and decodes nothing else', () => {
  assert.equal(extractTag('<A><UploadId>abc-123</UploadId></A>', 'UploadId'), 'abc-123');
  assert.equal(extractTag('<A><Key></Key></A>', 'Key'), undefined);
  assert.equal(extractTag('<A/>', 'UploadId'), undefined);
});

test('the documented defaults are the ones the client ships', () => {
  assert.equal(SINGLE_PUT_LIMIT_BYTES, 16 * 1024 * 1024);
  assert.equal(MULTIPART_PART_BYTES, 8 * 1024 * 1024);
});

/* ------------------------------------------------------------------ */
/* Against a real HTTP server                                          */
/* ------------------------------------------------------------------ */

function clientFor(fake: { url: string; bucket: string }, overrides: Partial<R2ClientDeps> = {}): R2Client {
  return new R2Client({
    accountId: 'account',
    accessKeyId: 'key-id',
    secretAccessKey: 'secret',
    bucket: fake.bucket,
    endpoint: fake.url,
    now: () => new Date('2024-01-02T03:04:05Z'),
    ...overrides,
  });
}

test('put sends a small body as one signed PUT', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    const body = Buffer.from('thumbnail bytes');
    const result = await r2.put('archive/movies/1/thumbnail.jpg', body, { contentType: 'image/jpeg' });
    assert.equal(result.parts, 1);
    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, sha256Hex(body));
    assert.equal(r2.requests, 1);
    const stored = fake.objects().get('archive/movies/1/thumbnail.jpg');
    assert.ok(stored);
    assert.equal(stored.body.toString('utf8'), 'thumbnail bytes');
    assert.equal(stored.contentType, 'image/jpeg');
    // The signer really ran: R2 was handed an AWS4-HMAC-SHA256 credential.
    assert.match(fake.transcript.requests[0]?.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=key-id\//);
  } finally {
    await fake.close();
  }
});

test('a key with spaces and unicode lands byte-for-byte under the same key', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    const key = 'archive/Movies/Amélie (2001)/mp4/1080p.mp4';
    await r2.put(key, Buffer.from('x'));
    assert.deepEqual([...fake.objects().keys()], [key]);
  } finally {
    await fake.close();
  }
});

test('a known length above the limit uploads as multipart and keeps the whole body', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake, { singlePutLimitBytes: 64, partBytes: 32 });
    const body = Buffer.alloc(200);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const result = await r2.put('big.bin', body, { contentLength: body.length });
    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, sha256Hex(body));
    assert.equal(result.parts, Math.ceil(body.length / 32));
    const stored = fake.objects().get('big.bin');
    assert.ok(stored);
    assert.deepEqual(stored.body, body);
    assert.equal(fake.transcript.multipartCreates, 1);
    assert.equal(fake.transcript.completes, 1);
    assert.equal(fake.transcript.aborts, 0);
  } finally {
    await fake.close();
  }
});

test('an unknown-length body that outgrows a single request switches mid-stream exactly once', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake, { singlePutLimitBytes: 64, partBytes: 32 });
    const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)];
    const expected = Buffer.concat(chunks);
    async function* source(): AsyncIterable<Buffer> {
      for (const chunk of chunks) yield chunk;
    }
    const result = await r2.put('stream.bin', source());
    // The byte count must not double-count the prefix, and the hash must cover
    // the prefix once: both regressions that a naive "replay what was read"
    // multipart switch introduces.
    assert.equal(result.bytes, expected.length);
    assert.equal(result.sha256, sha256Hex(expected));
    const stored = fake.objects().get('stream.bin');
    assert.ok(stored, 'the object was written');
    assert.deepEqual(stored.body, expected);
  } finally {
    await fake.close();
  }
});

test('a body that stays under the limit is a single PUT even when it arrives as chunks', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake, { singlePutLimitBytes: 1024, partBytes: 16 });
    async function* source(): AsyncIterable<Buffer> {
      yield Buffer.from('one ');
      yield Buffer.from('two ');
      yield Buffer.from('three');
    }
    const result = await r2.put('small.bin', source());
    assert.equal(result.parts, 1);
    assert.equal(fake.transcript.multipartCreates, 0);
    assert.equal(fake.objects().get('small.bin')?.body.toString('utf8'), 'one two three');
  } finally {
    await fake.close();
  }
});

test('a failed part aborts the multipart upload instead of leaving it open', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake, { singlePutLimitBytes: 32, partBytes: 16 });
    // 403 rather than 500: retryable statuses are retried by fetchWithPolicy.
    fake.failParts(1, 403);
    await assert.rejects(() => r2.put('broken.bin', Buffer.alloc(128, 7), { contentLength: 128 }), /403/);
    assert.equal(fake.transcript.aborts, 1, 'the orphaned upload was aborted');
    assert.equal(fake.objects().has('broken.bin'), false);
  } finally {
    await fake.close();
  }
});

test('a completion that fails also aborts the upload', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake, { singlePutLimitBytes: 16, partBytes: 16 });
    fake.failComplete(1, 403);
    await assert.rejects(() => r2.put('never.bin', Buffer.alloc(64, 9), { contentLength: 64 }), /403/);
    assert.equal(fake.transcript.aborts, 1);
    assert.equal(fake.objects().has('never.bin'), false);
  } finally {
    await fake.close();
  }
});

test('head reports the object, or nothing at all when it is not there', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    assert.equal(await r2.head('missing.bin'), undefined);
    assert.equal(await r2.exists('missing.bin'), false);
    await r2.put('present.bin', Buffer.from('four'));
    const info = await r2.head('present.bin');
    assert.ok(info);
    assert.equal(info.bytes, 4);
    assert.ok(info.etag);
    assert.equal(await r2.exists('present.bin'), true);
  } finally {
    await fake.close();
  }
});

test('a refused HEAD surfaces instead of reading as a missing object', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    await r2.put('present.bin', Buffer.from('x'));
    fake.failHeads(1, 403);
    await assert.rejects(() => r2.head('present.bin'), /403/);
    // A real 404 is still the quiet answer it should be.
    assert.equal(await r2.head('absent.bin'), undefined);
  } finally {
    await fake.close();
  }
});

test('delete removes the object and list reads a prefix back', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    await r2.put('archive/a/one.mp4', Buffer.from('1'));
    await r2.put('archive/a/two.mp4', Buffer.from('2'));
    await r2.put('archive/b/three.mp4', Buffer.from('3'));
    const listed = await r2.list('archive/a/');
    assert.deepEqual(listed.sort(), ['archive/a/one.mp4', 'archive/a/two.mp4']);
    assert.deepEqual((await r2.list('archive/')).sort(), ['archive/a/one.mp4', 'archive/a/two.mp4', 'archive/b/three.mp4']);
    await r2.delete('archive/a/one.mp4');
    assert.equal(await r2.exists('archive/a/one.mp4'), false);
    assert.equal(fake.transcript.deletes, 1);
  } finally {
    await fake.close();
  }
});

test('list stops at the requested limit', async () => {
  const fake = await startFakeR2();
  try {
    const r2 = clientFor(fake);
    for (let index = 0; index < 5; index += 1) await r2.put(`archive/${index}.mp4`, Buffer.from('x'));
    assert.equal((await r2.list('archive/', 2)).length, 2);
  } finally {
    await fake.close();
  }
});
