import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorized, isPublicPath, parseBasicAuthorization } from '../src/auth';

const expected = { user: 'index', password: 's3cret-pass' };
const header = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

test('the login accepts exactly the configured credentials', () => {
  assert.equal(isAuthorized(header('index', 's3cret-pass'), expected), true);
  assert.equal(isAuthorized(header('index', 'wrong'), expected), false);
  assert.equal(isAuthorized(header('admin', 's3cret-pass'), expected), false);
  assert.equal(isAuthorized(header('Index', 's3cret-pass'), expected), false, 'the user name is case-sensitive');
  assert.equal(isAuthorized(undefined, expected), false, 'no header is not a login');
  assert.equal(isAuthorized('Bearer something', expected), false, 'only Basic is accepted');
  assert.equal(isAuthorized(`Basic ${Buffer.from('no-colon-here').toString('base64')}`, expected), false);
});

test('the parser reads the scheme case-insensitively and keeps colons in the password', () => {
  assert.deepEqual(parseBasicAuthorization(`  basic ${Buffer.from('index:s3cret-pass').toString('base64')}  `), expected);
  assert.deepEqual(parseBasicAuthorization(header('index', 'a:b:c')), { user: 'index', password: 'a:b:c' });
  assert.equal(parseBasicAuthorization('Basic '), undefined, 'the padded form of an empty header does not match');
  assert.equal(parseBasicAuthorization('Digest abc'), undefined);
});

test('only the health check and the relay are open without a login', () => {
  assert.equal(isPublicPath('/api/health'), true);
  assert.equal(isPublicPath('/relay/0123abcd/stream.ts'), true);
  assert.equal(isPublicPath('/relay/0123abcd/master.m3u8'), true);
  assert.equal(isPublicPath('/api/healthz'), false, 'the exception is the exact path, not a prefix');
  assert.equal(isPublicPath('/api/jobs'), false);
  assert.equal(isPublicPath('/api/accounts'), false);
  assert.equal(isPublicPath('/relaysomething'), false);
  assert.equal(isPublicPath('/'), false);
});
