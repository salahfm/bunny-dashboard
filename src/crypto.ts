import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';

export function loadOrCreateSecret(secretPath: string): Buffer {
  if (fs.existsSync(secretPath)) {
    const hex = fs.readFileSync(secretPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, `${secret.toString('hex')}\n`, { mode: 0o600 });
  return secret;
}

export function encryptSecret(secret: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, secret, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(secret: Buffer, payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported secret payload');
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ciphertext = Buffer.from(parts[3] as string, 'base64url');
  const decipher = crypto.createDecipheriv(ALGORITHM, secret, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Never send a stored key back to the browser — only its last four characters. */
export function maskSecret(plain: string | undefined): string | null {
  if (!plain) return null;
  if (plain.length <= 4) return '••••';
  return `••••${plain.slice(-4)}`;
}
