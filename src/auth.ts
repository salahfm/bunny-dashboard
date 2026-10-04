/**
 * Optional login for the dashboard.
 *
 * Off unless `DASHBOARD_PASSWORD` is set: the dashboard listens on 127.0.0.1 by
 * default, and a local-only instance does not need a password. On a public
 * address it does — the store holds Bunny and TMDB credentials, and the queue
 * can delete videos.
 *
 * Two paths stay open on purpose:
 *   /api/health  the platform's health check, which cannot log in;
 *   /relay/...   Bunny Stream fetching the relay — it sends no credentials, and
 *                the URL carries a 128-bit token instead.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface DashboardAuth {
  user: string;
  password: string;
}

/** Paths a machine caller needs without credentials. */
export function isPublicPath(path: string): boolean {
  if (path === '/api/health') return true;
  if (path === '/relay' || path.startsWith('/relay/')) return true;
  return false;
}

/** `Authorization: Basic …` → the credentials it carries, when it parses. */
export function parseBasicAuthorization(header: string | undefined): DashboardAuth | undefined {
  if (!header) return undefined;
  const encoded = /^Basic\s+(.+)$/i.exec(header.trim())?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Constant-time comparison of one half of the credentials. */
function matches(given: string, expected: string): boolean {
  const left = crypto.createHash('sha256').update(given, 'utf8').digest();
  const right = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Whether the header carries exactly the configured credentials. Both halves
 * are digested before either comparison runs, so a wrong user name and a wrong
 * password take the same time to reject (and swap nothing about their length).
 */
export function isAuthorized(header: string | undefined, expected: DashboardAuth): boolean {
  const given = parseBasicAuthorization(header);
  if (!given) return false;
  const userOk = matches(given.user, expected.user);
  const passwordOk = matches(given.password, expected.password);
  return userOk && passwordOk;
}

/** The gate: everything except the two public paths needs the login. */
export function authGate(auth: DashboardAuth | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!auth || isPublicPath(req.path)) {
      next();
      return;
    }
    if (isAuthorized(req.headers.authorization, auth)) {
      next();
      return;
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="Bunny Publisher Dashboard", charset="UTF-8"')
      .set('Cache-Control', 'no-store')
      .json({ error: 'authentication required' });
  };
}
