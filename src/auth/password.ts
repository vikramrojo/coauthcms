/**
 * The operator's password sign-in, as Hono routes a host mounts, on session rows.
 * It keeps the behaviour reviewed in the README's "The auth package" section: the cookie is
 * signed with its own key (never the password), the password is compared as
 * fixed-length digests, failed attempts per Cloudflare-reported address are
 * limited through `auth_attempts`, and signing out everywhere deletes every
 * `admin` session row.
 */
import { Hono, type Context, type Next } from 'hono';
import {
  clearSessionCookie,
  createSession,
  endSession,
  hasKey,
  readSession,
  revokeSessions,
  type RequestSource,
  type Session,
  type SessionConfig
} from './session.ts';

export const ADMIN_KIND = 'admin';
export const PASSWORD_METHOD = 'password';

export interface PasswordOptions {
  /** Cookie name; Koguma's was `koguma_session`. */
  cookieName?: string;
  /** Session lifetime in seconds (24 hours). */
  lifetimeSeconds?: number;
  /** Failed attempts allowed per address within the window. */
  maxAttempts?: number;
  /** Names of the env bindings. */
  envNames?: { password?: string; sessionKey?: string; db?: string };
  now?: () => number;
}

interface Resolved {
  cookieName: string;
  lifetimeSeconds: number;
  maxAttempts: number;
  password: string;
  sessionKey: string;
  db: string;
  now?: () => number;
}

const RETRY_AFTER_SECONDS = 15 * 60; // the "-15 minutes" window in the SQL below

function resolve(options: PasswordOptions): Resolved {
  return {
    cookieName: options.cookieName ?? 'koguma_session',
    lifetimeSeconds: options.lifetimeSeconds ?? 24 * 60 * 60,
    maxAttempts: options.maxAttempts ?? 5,
    password: options.envNames?.password ?? 'KOGUMA_SECRET',
    sessionKey: options.envNames?.sessionKey ?? 'KOGUMA_SESSION_KEY',
    db: options.envNames?.db ?? 'DB',
    ...(options.now ? { now: options.now } : {})
  };
}

const env = (c: { env?: unknown }): Record<string, unknown> => (c.env ?? {}) as Record<string, unknown>;

function configFor(r: Resolved, envBag: Record<string, unknown>): SessionConfig {
  const key = envBag[r.sessionKey];
  return {
    cookieName: r.cookieName,
    secret: typeof key === 'string' ? key : '',
    lifetimeSeconds: r.lifetimeSeconds,
    ...(r.now ? { now: r.now } : {})
  };
}

const dbOf = (r: Resolved, envBag: Record<string, unknown>) => envBag[r.db] as D1Database | undefined;

/** Equal-length digests of both strings, compared without an early exit. */
async function passwordsMatch(given: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const digest = async (value: string) => {
    const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  };
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function recentAttempts(db: D1Database, ip: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND attempted_at > datetime('now','-15 minutes')`)
    .bind(ip)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function clearAttempts(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE ip = ?').bind(ip).run();
  await db.prepare(`DELETE FROM auth_attempts WHERE attempted_at <= datetime('now','-15 minutes')`).run();
}

/** The admin session of a request, with the reason for none. Never writes. */
export async function resolveAdminSession(
  source: RequestSource,
  envBag: Record<string, unknown>,
  options: PasswordOptions = {}
): Promise<{ session: Session; reason?: undefined } | { session: null; reason: string; clear: boolean }> {
  const r = resolve(options);
  const config = configFor(r, envBag);
  if (!hasKey(config)) return { session: null, reason: `${r.sessionKey} not configured`, clear: false };
  const read = await readSession(source, dbOf(r, envBag), config);
  if (read.session === null) {
    const reason = read.reason === 'missing' ? 'Not authenticated' : read.reason === 'expired' ? 'Session expired' : read.reason === 'gone' ? 'Session revoked' : 'Invalid session';
    return { session: null, reason, clear: read.clear };
  }
  if (read.session.kind !== ADMIN_KIND) return { session: null, reason: 'Invalid session', clear: false };
  return { session: read.session };
}

/** `{ kind: 'admin' }` when the request carries a live admin session, else null. */
export async function resolveAdmin(c: Context | RequestSource, options: PasswordOptions = {}): Promise<{ kind: 'admin' } | null> {
  const got = await resolveAdminSession(c as RequestSource, env(c as { env?: unknown }), options);
  return got.session ? { kind: 'admin' } : null;
}

/** Refuses with 401 anyone without an admin session. */
export function requireAdmin(options: PasswordOptions = {}) {
  const r = resolve(options);
  return async (c: Context, next: Next): Promise<Response | void> => {
    const envBag = env(c);
    if (!envBag[r.password]) return c.json({ error: `${r.password} not configured` }, 500);
    const got = await resolveAdminSession(c, envBag, options);
    if (!got.session) {
      if (got.clear) clearSessionCookie(c, configFor(r, envBag));
      return c.json({ error: got.reason }, 401);
    }
    c.set('principal' as never, { kind: 'admin' } as never);
    await next();
  };
}

/**
 * The routes, to mount at `/api/auth` as Koguma's were:
 * POST /login, POST /logout, POST /logout-all (admin only), GET /me (admin only).
 */
export function passwordRoutes(options: PasswordOptions = {}): Hono {
  const r = resolve(options);
  const app = new Hono();

  app.post('/login', async c => {
    const envBag = env(c);
    const secret = envBag[r.password];
    const config = configFor(r, envBag);
    const db = dbOf(r, envBag);
    if (typeof secret !== 'string' || !secret || !hasKey(config) || !db) {
      return c.json({ error: `${r.password} and ${r.sessionKey} (32+ characters) must be configured` }, 500);
    }
    // Only Cloudflare's own header: X-Forwarded-For is client-supplied.
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';

    if ((await recentAttempts(db, ip)) >= r.maxAttempts) {
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
    }

    let body: { password?: unknown };
    try {
      body = await c.req.json<{ password?: unknown }>();
    } catch {
      return c.json({ error: 'Password required' }, 400);
    }
    if (typeof body.password !== 'string' || !body.password) return c.json({ error: 'Password required' }, 400);

    if (!(await passwordsMatch(body.password, secret))) {
      await db.prepare('INSERT INTO auth_attempts (ip) VALUES (?)').bind(ip).run();
      return c.json({ error: 'Invalid password' }, 401);
    }
    await clearAttempts(db, ip);
    await createSession(c, db, config, { ownerId: null, kind: ADMIN_KIND, method: PASSWORD_METHOD });
    return c.json({ ok: true });
  });

  app.post('/logout', async c => {
    const envBag = env(c);
    const db = dbOf(r, envBag);
    if (db) await endSession(c, db, configFor(r, envBag));
    else clearSessionCookie(c, configFor(r, envBag));
    return c.json({ ok: true });
  });

  app.post('/logout-all', requireAdmin(options), async c => {
    const envBag = env(c);
    await revokeSessions(dbOf(r, envBag)!, { kind: ADMIN_KIND });
    clearSessionCookie(c, configFor(r, envBag));
    return c.json({ ok: true });
  });

  app.get('/me', requireAdmin(options), c => c.json({ authenticated: true }));

  return app;
}
