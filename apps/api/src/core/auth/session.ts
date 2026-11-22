import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Role } from '@tailorit/shared';
import type { AppDeps, SessionUser } from '../context';
import { DAY_MS } from '@tailorit/shared';
import { publicOriginOf } from '../../config/public-origin'; // v34 ORIGIN2

// A session is an opaque random token in an httpOnly cookie. The database keeps only the token's SHA-256, so a copy of
// the database holds no usable session. Plain SHA-256 is enough: the input is 32 random bytes, not a password, so a
// slow hash would defend nothing and cost time on every request.
// v34 ORIGIN2 (the ORIGIN2 review, finding 2; migration 0056): a session belongs to the public origin it was signed in at
// (config/public-origin.ts publicOriginOf: APP_ORIGIN, an exact address of TRUSTED_PUBLIC_HOSTS or a test tunnel's), and
// a request is signed in only through a session of its own public origin. Browsers keep cookies per host, but a cookie
// sent in clear at a plain-http LAN address must not work at the https addresses of the same server (APP_ORIGIN, the
// tunnel) if someone on that network copies it. A session made before 0056 (origin NULL) is APP_ORIGIN's. Sign-out and
// the extension's tokens (extension-tokens.ts) do not look at it.

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE = 'ti_session';

/** 32 random bytes in base64url are 43 characters; anything far off that is not one of ours. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
/** `last_seen_at` is written at most this often per session, so ordinary reads do not all become writes. */
const LAST_SEEN_EVERY_MS = 60_000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** SESSION_TTL_DAYS in milliseconds: the row's lifetime and the cookie's Max-Age, so the two end together. */
export function sessionTtlMs(deps: Pick<AppDeps, 'config'>): number {
  return deps.config.auth.sessionTtlDays * DAY_MS;
}

export interface CreatedSession {
  /** The raw token: goes into the cookie and nowhere else. */
  token: string;
  tokenHash: string;
  expiresAt: string;
}

/**
 * Opens a session for `userId`, at the request's public origin (v34 ORIGIN2; APP_ORIGIN without a request). The expiry
 * is fixed here and never extended (not sliding).
 */
export async function createSession(deps: Pick<AppDeps, 'db' | 'now' | 'config'>, userId: string, req?: Request): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const now = deps.now();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + sessionTtlMs(deps)).toISOString();
  const userAgent = req?.get('user-agent')?.slice(0, 500) ?? null;
  const origin = req ? publicOriginOf(deps.config, req) : deps.config.appOrigin; // v34 ORIGIN2
  await deps.db.run(
    `INSERT INTO user_sessions(token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tokenHash, userId, createdAt, expiresAt, createdAt, userAgent, req?.ip ?? null, origin],
  );
  return { token, tokenHash, expiresAt };
}

/**
 * Whether the cookies of `req` are marked Secure: when its public origin is https (v34 ORIGIN2, the review's finding 5).
 * An exact address's scheme is the one TRUSTED_PUBLIC_HOSTS fixes, never X-Forwarded-Proto; a tunnel's (a pattern) and
 * APP_ORIGIN's are as config/public-origin.ts derives them. A Secure cookie is never sent back over plain http (a LAN
 * install), and one made at an https address never travels in clear.
 */
export function secureCookieAt(deps: Pick<AppDeps, 'config'>, req: Request): boolean {
  return publicOriginOf(deps.config, req).startsWith('https:');
}

/** Sets the session cookie. SameSite=Lax (not Strict) so following a link into the app keeps the person signed in. */
export function setSessionCookie(req: Request, res: Response, deps: Pick<AppDeps, 'config'>, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookieAt(deps, req),
    path: '/',
    maxAge: sessionTtlMs(deps),
  });
}

export function clearSessionCookie(req: Request, res: Response, deps: Pick<AppDeps, 'config'>): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookieAt(deps, req), path: '/' });
}

/** The session token a request carries, or null (cookie-parser has run; a `j:` value parses to a non-string). */
export function readSessionToken(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

export async function destroySession(deps: Pick<AppDeps, 'db'>, tokenHash: string): Promise<void> {
  await deps.db.run('DELETE FROM user_sessions WHERE token_hash = ?', [tokenHash]);
}

/** Ends every session of an account (disabling it). Returns how many there were. */
export async function destroySessionsForUser(deps: Pick<AppDeps, 'db'>, userId: string): Promise<number> {
  return (await deps.db.run('DELETE FROM user_sessions WHERE user_id = ?', [userId])).changes;
}

export async function pruneExpiredSessions(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  return (await deps.db.run('DELETE FROM user_sessions WHERE expires_at <= ?', [deps.now().toISOString()])).changes;
}

interface SessionRow {
  user_id: string;
  origin: string | null; // v34 ORIGIN2
  expires_at: string;
  last_seen_at: string | null;
  email: string;
  name: string;
  role: Role;
  disabled_at: string | null;
}

/**
 * The account behind a session token used at `origin` (the request's public origin), or null. An expired session is
 * deleted on sight; a disabled account resolves to null even with a live session, so disabling takes effect on the next
 * request. v34 ORIGIN2: a session made at another origin is null here (and kept: it still works at its own); one made
 * before migration 0056 belongs to APP_ORIGIN.
 */
export async function resolveSession(deps: AppDeps, token: string, origin: string): Promise<{ user: SessionUser; tokenHash: string } | null> {
  const tokenHash = hashSessionToken(token);
  const row = await deps.db.one<SessionRow>(
    `SELECT s.user_id, s.origin, s.expires_at, s.last_seen_at, u.email, u.name, u.role, u.disabled_at
     FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  if ((row.origin ?? deps.config.appOrigin) !== origin) return null; // v34 ORIGIN2

  const now = deps.now();
  if (Date.parse(row.expires_at) <= now.getTime()) {
    await destroySession(deps, tokenHash);
    return null;
  }
  if (row.disabled_at) return null;

  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : Number.NaN;
  if (Number.isNaN(lastSeen) || now.getTime() - lastSeen >= LAST_SEEN_EVERY_MS) {
    await deps.db.run('UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?', [now.toISOString(), tokenHash]);
  }
  return { user: { id: row.user_id, email: row.email, name: row.name, role: row.role }, tokenHash };
}

/**
 * Reads the session cookie and sets `req.user` (or leaves it undefined). Never refuses a request by itself; the route
 * guards in guards.ts do.
 *
 * A cookie that no longer works is left alone rather than cleared here: a request still in flight with an old token
 * would otherwise answer with a clearing Set-Cookie after a fresh sign-in had set the new one, and sign the person out.
 * It is replaced at the next sign-in and cleared by logout.
 */
export function attachUser(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    // A request that names an extension token is that token's alone (attachBearer): its cookie is never read.
    if (req.authVia === 'token') return next();
    const token = readSessionToken(req);
    if (!token) return next();
    try {
      const session = await resolveSession(deps, token, publicOriginOf(deps.config, req)); // v34 ORIGIN2
      if (session) {
        req.user = session.user;
        req.sessionTokenHash = session.tokenHash;
        req.authVia = 'session';
      }
    } catch (error) {
      // An unreadable database is not this request's to report; it arrives signed out and the route says so.
      deps.log.error('[auth] could not read a session', error);
    }
    next();
  };
}
