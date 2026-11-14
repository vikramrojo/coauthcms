/**
 * Task 5.3: the operator's password sign-in of packages/auth on session rows. Each
 * case of test/auth.test.ts and test/service/auth-review.test.ts is here, with the
 * stateless cookie replaced by a session row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { serializeSigned } from 'hono/utils/cookie';
import { passwordRoutes, resolveAdmin, requireAdmin, createSession } from '../src/auth/index.ts';
import { createDb, type TestDb } from './support.ts';

const PASSWORD = 'correct horse battery staple';
const KEY = 'a-session-signing-key-that-is-32+-chars';
let t: TestDb;
let now = 1_000_000_000_000;

const app = new Hono();
app.route('/api/auth', passwordRoutes({ now: () => now }));
app.get('/api/whoami', async c => c.json({ principal: await resolveAdmin(c, { now: () => now }) }));
app.get('/api/admin/thing', requireAdmin({ now: () => now }), c => c.json({ ok: true }));
app.post('/api/other/start', async c => {
  await createSession(c, (c.env as any).DB, { cookieName: 'composer', secret: KEY, lifetimeSeconds: 60 }, { ownerId: 'o', kind: 'composer', method: 'handoff' });
  return c.json({ ok: true });
});

const baseEnv = () => ({ DB: t.db, KOGUMA_SECRET: PASSWORD, KOGUMA_SESSION_KEY: KEY }) as Record<string, unknown>;

beforeAll(async () => {
  t = await createDb();
});
afterAll(() => t.dispose());
beforeEach(async () => {
  now = 1_000_000_000_000;
  for (const table of ['sessions', 'auth_attempts', 'auth_meta']) await t.db.prepare(`DELETE FROM ${table}`).run();
});

const login = (password: unknown, env: Record<string, unknown> = baseEnv(), headers: Record<string, string> = {}, raw?: string) =>
  app.request(
    '/api/auth/login',
    { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.7', ...headers }, body: raw ?? JSON.stringify({ password }) },
    env
  );
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const signIn = async (ip = '198.51.100.7') => cookieOf(await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': ip }));
const me = (cookie?: string, env: Record<string, unknown> = baseEnv()) => app.request('/api/auth/me', { headers: cookie ? { cookie } : {} }, env);
const signed = async (name: string, value: string, key: string) => (await serializeSigned(name, value, key, { path: '/' })).split(';')[0]!;
const count = async (sql: string) => (await t.db.prepare(sql).first<{ n: number }>())!.n;

describe('login rate limiting', () => {
  test('429 with Retry-After after 5 failures from one address, even for the right password', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) expect((await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(401);
    const blocked = await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': ip });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('900');
    expect(((await blocked.json()) as { error: string }).error).toContain('Too many login attempts');
    expect((await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(429);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  test('the limit lifts when its window passes', async () => {
    const ip = '10.0.0.9';
    for (let i = 0; i < 5; i++) await login('wrong', baseEnv(), { 'CF-Connecting-IP': ip });
    expect((await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(429);
    await t.db.prepare(`UPDATE auth_attempts SET attempted_at = datetime('now','-16 minutes')`).run();
    expect((await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(200);
  });

  test('a correct password before the limit succeeds and clears the counter', async () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 4; i++) expect((await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(401);
    expect((await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(401);
    expect((await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': ip })).status).toBe(429);
  });

  test('another address is not affected', async () => {
    expect((await login('wrong-password', baseEnv(), { 'CF-Connecting-IP': '10.0.0.3' })).status).toBe(401);
    expect((await login(PASSWORD, baseEnv(), { 'CF-Connecting-IP': '10.0.0.3' })).status).toBe(200);
  });

  test('X-Forwarded-For cannot dodge the limit', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await login('wrong', baseEnv(), { 'X-Forwarded-For': `10.0.0.${i}`, 'CF-Connecting-IP': '198.51.100.99' })).status;
    expect(last).toBe(429);
    expect((await login(PASSWORD, baseEnv(), { 'X-Forwarded-For': '10.9.9.9', 'CF-Connecting-IP': '198.51.100.99' })).status).toBe(429);
  });
});

describe('the password check', () => {
  test('wrong passwords of any length are refused, including prefixes and extensions of the right one', async () => {
    let n = 0;
    for (const wrong of ['', 'x', PASSWORD.slice(0, -1), PASSWORD + 'x', PASSWORD.toUpperCase(), 'y'.repeat(500)]) {
      const res = await login(wrong, baseEnv(), { 'CF-Connecting-IP': `198.51.100.${++n}` });
      expect([400, 401]).toContain(res.status);
    }
    expect((await login(PASSWORD)).status).toBe(200);
  });

  test('malformed login bodies are a 400, not a crash', async () => {
    expect((await login(null, baseEnv(), {}, 'not json')).status).toBe(400);
    expect((await login(null, baseEnv(), {}, JSON.stringify({ password: 12345 }))).status).toBe(400);
    expect((await login(null, baseEnv(), {}, JSON.stringify({}))).status).toBe(400);
  });

  test('a successful login starts an admin session row by password with no owner', async () => {
    await login(PASSWORD);
    const row = await t.db.prepare('SELECT owner_id, kind, method, expires_at - created_at AS span FROM sessions').first<any>();
    expect(row).toEqual({ owner_id: null, kind: 'admin', method: 'password', span: 86_400_000 });
  });
});

describe('the cookie', () => {
  test('is HttpOnly, Secure, SameSite=Strict, scoped to the site, lasts 24 hours and holds no password', async () => {
    const res = await login(PASSWORD);
    const cookie = res.headers.get('set-cookie')!;
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=86400']) expect(cookie).toContain(part);
    expect(cookie).not.toContain('Domain=');
    expect(cookie).toContain('koguma_session=');
    expect(cookie).not.toContain(PASSWORD);
  });

  test('a signed-in cookie is accepted', async () => {
    expect((await me(await signIn())).status).toBe(200);
  });

  test('an expired session is refused', async () => {
    const cookie = await signIn();
    now += 86_400_000;
    const res = await me(cookie);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('a tampered signature is refused', async () => {
    const cookie = (await signIn()).replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    expect((await me(cookie)).status).toBe(401);
  });

  test('the old stateless cookie (an exp payload signed with the session key) is refused', async () => {
    const payload = JSON.stringify({ exp: Math.floor(now / 1000) + 3600, gen: 0 });
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload));
    const legacy = `koguma_session=${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
    expect((await me(legacy)).status).toBe(401);
  });

  test('a signature over a row id that does not exist is refused', async () => {
    expect((await me(await signed('koguma_session', 'no-such-row', KEY))).status).toBe(401);
  });
});

describe('the signing key', () => {
  test('is its own secret: a cookie for a real row signed with the login password is refused', async () => {
    const cookie = await signIn();
    const id = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
    expect((await me(await signed('koguma_session', id, PASSWORD))).status).toBe(401);
    expect((await me(await signed('koguma_session', id, KEY))).status).toBe(200);
  });

  test('login refuses to run without a session key, or with a short one', async () => {
    for (const KOGUMA_SESSION_KEY of [undefined, '', 'short']) {
      expect((await login(PASSWORD, { ...baseEnv(), KOGUMA_SESSION_KEY })).status).toBe(500);
    }
    expect((await login(PASSWORD, { ...baseEnv(), KOGUMA_SECRET: undefined })).status).toBe(500);
  });

  test('a session cannot be verified without a session key', async () => {
    const cookie = await signIn();
    expect((await me(cookie, { ...baseEnv(), KOGUMA_SESSION_KEY: 'short' })).status).toBe(401);
  });

  test('without a database no session is accepted (fails closed), and login is refused', async () => {
    const cookie = await signIn();
    expect((await me(cookie, { ...baseEnv(), DB: undefined })).status).toBe(401);
    expect((await login(PASSWORD, { ...baseEnv(), DB: undefined })).status).toBe(500);
  });
});

describe('signing out', () => {
  test('logout removes the row and the same cookie then gives no session', async () => {
    const cookie = await signIn();
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } }, baseEnv());
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await me(cookie)).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(0);
  });

  test('logout with no cookie is still ok', async () => {
    expect((await app.request('/api/auth/logout', { method: 'POST' }, baseEnv())).status).toBe(200);
  });
});

describe('sign out everywhere', () => {
  test('invalidates every admin session; a fresh login still works', async () => {
    const a = await signIn('10.0.1.1');
    const b = await signIn('10.0.1.2');
    expect((await me(a)).status).toBe(200);
    const all = await app.request('/api/auth/logout-all', { method: 'POST', headers: { cookie: a } }, baseEnv());
    expect(all.status).toBe(200);
    expect(((await all.json()) as { ok: boolean }).ok).toBe(true);
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(401);
    expect(await count(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'admin'`)).toBe(0);
    expect((await me(await signIn('10.0.1.3'))).status).toBe(200);
  });

  test('requires authentication', async () => {
    expect((await app.request('/api/auth/logout-all', { method: 'POST' }, baseEnv())).status).toBe(401);
  });

  test('leaves sessions of other kinds alone and does not touch auth_meta', async () => {
    await app.request('/api/other/start', { method: 'POST' }, baseEnv());
    const cookie = await signIn();
    await app.request('/api/auth/logout-all', { method: 'POST', headers: { cookie } }, baseEnv());
    expect(await count(`SELECT COUNT(*) AS n FROM sessions WHERE kind = 'composer'`)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM auth_meta')).toBe(0);
  });
});

describe('who is the admin', () => {
  test('resolveAdmin gives { kind: admin } for an admin session and null otherwise', async () => {
    const cookie = await signIn();
    const get = async (c?: string) => ((await app.request('/api/whoami', { headers: c ? { cookie: c } : {} }, baseEnv())).json() as Promise<{ principal: unknown }>);
    expect((await get(cookie)).principal).toEqual({ kind: 'admin' });
    expect((await get()).principal).toBeNull();
  });

  test('a session of another kind in the admin cookie is not an admin', async () => {
    await t.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').bind('c1', 'o', 'composer', 'handoff', now, now + 60_000).run();
    expect((await me(await signed('koguma_session', 'c1', KEY))).status).toBe(401);
  });

  test('requireAdmin guards a route, and names a missing password secret', async () => {
    expect((await app.request('/api/admin/thing', {}, baseEnv())).status).toBe(401);
    expect((await app.request('/api/admin/thing', { headers: { cookie: await signIn() } }, baseEnv())).status).toBe(200);
    expect((await app.request('/api/admin/thing', {}, { ...baseEnv(), KOGUMA_SECRET: undefined })).status).toBe(500);
  });
});
