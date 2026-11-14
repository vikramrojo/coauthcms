/**
 * Sessions: a row in `sessions` named by a signed cookie. The cookie holds only a
 * random id; the row says whose session it is (an opaque `owner_id`, null for the
 * operator), what `kind` of person (`admin`, or whatever the host calls them), how
 * it was started (`method`) and when it ends. Times are epoch milliseconds.
 */
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';

export interface SessionConfig {
  /** The cookie's name. A host with two kinds of session uses two names. */
  cookieName: string;
  /** The signing key, at least 32 characters. Never a password. */
  secret: string;
  /** How long a session lasts, in seconds. */
  lifetimeSeconds: number;
  /** The clock, in epoch milliseconds; tests move it. */
  now?: () => number;
}

export interface Session {
  id: string;
  ownerId: string | null;
  kind: string;
  method: string;
  createdAt: number;
  expiresAt: number;
}

export interface NewSession {
  ownerId: string | null;
  kind: string;
  method: string;
}

/** Anything that carries the request: a Hono context, or `{ req: { raw } }` built from a Request. */
export interface RequestSource {
  req: { raw: Request };
}

export type SessionRead =
  | { session: Session }
  | { session: null; reason: 'unconfigured' | 'missing' | 'invalid' | 'expired' | 'gone'; clear: boolean };

export const MIN_KEY_LENGTH = 32;

interface Row {
  id: string;
  owner_id: string | null;
  kind: string;
  method: string;
  created_at: number;
  expires_at: number;
}

const toSession = (row: Row): Session => ({
  id: row.id,
  ownerId: row.owner_id,
  kind: row.kind,
  method: row.method,
  createdAt: row.created_at,
  expiresAt: row.expires_at
});

export const clock = (config: { now?: () => number }): number => (config.now ?? Date.now)();

export function hasKey(config: SessionConfig): boolean {
  return typeof config.secret === 'string' && config.secret.length >= MIN_KEY_LENGTH;
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cookieOptions = (maxAge: number) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'Strict' as const, maxAge });

/** Starts a session: writes the row and sets the signed cookie. */
export async function createSession(c: Context, db: D1Database, config: SessionConfig, init: NewSession): Promise<Session> {
  if (!hasKey(config)) throw new Error(`The session signing key must be at least ${MIN_KEY_LENGTH} characters.`);
  if (!init.kind || !init.method) throw new TypeError('A session records its kind and method.');
  const createdAt = clock(config);
  const session: Session = {
    id: randomToken(),
    ownerId: init.ownerId,
    kind: init.kind,
    method: init.method,
    createdAt,
    expiresAt: createdAt + config.lifetimeSeconds * 1000
  };
  await db
    .prepare('INSERT INTO sessions (id, owner_id, kind, method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(session.id, session.ownerId, session.kind, session.method, session.createdAt, session.expiresAt)
    .run();
  await setSignedCookie(c, config.cookieName, session.id, config.secret, cookieOptions(config.lifetimeSeconds));
  return session;
}

/** The session the request's cookie names, or why there is none. Read-only. */
export async function readSession(source: RequestSource, db: D1Database | undefined, config: SessionConfig): Promise<SessionRead> {
  if (!db || !hasKey(config)) return { session: null, reason: 'unconfigured', clear: false };
  const value = await getSignedCookie(source as unknown as Context, config.secret, config.cookieName);
  if (value === undefined) return { session: null, reason: 'missing', clear: false };
  if (value === false || value === '') return { session: null, reason: 'invalid', clear: false };
  const row = await db.prepare('SELECT id, owner_id, kind, method, created_at, expires_at FROM sessions WHERE id = ?').bind(value).first<Row>();
  if (!row) return { session: null, reason: 'gone', clear: true };
  if (row.expires_at <= clock(config)) return { session: null, reason: 'expired', clear: true };
  return { session: toSession(row) };
}

/** Clears the session cookie on the response. */
export function clearSessionCookie(c: Context, config: SessionConfig): void {
  deleteCookie(c, config.cookieName, { path: '/', httpOnly: true, secure: true, sameSite: 'Strict' } as Parameters<typeof deleteCookie>[2]);
}

/** Signs out: removes the row the cookie names, if it is validly signed, and clears the cookie. */
export async function endSession(c: Context, db: D1Database, config: SessionConfig): Promise<void> {
  if (hasKey(config)) {
    const value = await getSignedCookie(c, config.secret, config.cookieName);
    if (typeof value === 'string' && value) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(value).run();
  }
  clearSessionCookie(c, config);
}

/**
 * Deletes every session of one owner, of one kind, or both together; returns how
 * many. With neither given it refuses, so a missing id cannot end everyone's.
 */
export async function revokeSessions(db: D1Database, filter: { ownerId?: string; kind?: string }): Promise<number> {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.ownerId !== undefined) (where.push('owner_id = ?'), values.push(filter.ownerId));
  if (filter.kind !== undefined) (where.push('kind = ?'), values.push(filter.kind));
  if (where.length === 0) throw new TypeError('Revoking sessions needs an owner, a kind, or both.');
  const result = await db.prepare(`DELETE FROM sessions WHERE ${where.join(' AND ')}`).bind(...values).run();
  return result.meta?.changes ?? 0;
}

/** Removes sessions past their end; the host may run it daily. Returns how many. */
export async function purgeExpiredSessions(db: D1Database, now: number = Date.now()): Promise<number> {
  const result = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  return result.meta?.changes ?? 0;
}
