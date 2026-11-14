/** Task 5.1, 5.2, 5.4: sessions, handoff tokens and the principal resolver of packages/auth. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { serializeSigned } from 'hono/utils/cookie';
import {
  createPrincipalResolver,
  createSession,
  endSession,
  exchangeHandoffToken,
  mintHandoffToken,
  purgeExpiredHandoffTokens,
  purgeExpiredSessions,
  readSession,
  revokeSessions,
  sha256Hex,
  type SessionConfig
} from '../src/auth/index.ts';
import { createDb, type TestDb } from './support.ts';

const KEY = 'a-session-signing-key-that-is-32+-chars';
let t: TestDb;
let now = 1_000_000_000_000;
const config: SessionConfig = { cookieName: 'sid', secret: KEY, lifetimeSeconds: 3600, now: () => now };

beforeAll(async () => {
  t = await createDb();
});
afterAll(() => t.dispose());
beforeEach(async () => {
  now = 1_000_000_000_000;
  await t.db.prepare('DELETE FROM sessions').run();
  await t.db.prepare('DELETE FROM handoff_tokens').run();
});

/** A tiny app over the package, so cookies travel as real headers. */
function makeApp() {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.post('/start', async c => {
    const body = await c.req.json<{ owner: string | null; kind: string; method?: string }>();
    const s = await createSession(c, c.env.DB, config, { ownerId: body.owner, kind: body.kind, method: body.method ?? 'test' });
    return c.json(s);
  });
  app.get('/who', async c => {
    const r = await readSession(c, c.env.DB, config);
    return c.json(r.session ? { session: r.session } : { session: null, reason: r.reason });
  });
  app.post('/out', async c => {
    await endSession(c, c.env.DB, config);
    return c.json({ ok: true });
  });
  app.get('/exchange', async c => {
    const s = await exchangeHandoffToken(c, c.env.DB, config, c.req.query('token') ?? '', 'composer');
    return s ? c.json(s) : c.json({ error: 'refused' }, 401);
  });
  return app;
}
const app = makeApp();
const call = (path: string, init: RequestInit = {}) => app.request(path, init, { DB: t.db });
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const start = async (owner: string | null, kind: string) => {
  const res = await call('/start', { method: 'POST', body: JSON.stringify({ owner, kind }), headers: { 'content-type': 'application/json' } });
  return { cookie: cookieOf(res), res };
};
const who = async (cookie?: string) => (await call('/who', { headers: cookie ? { cookie } : {} })).json() as Promise<{ session: any; reason?: string }>;

describe('a session is a row behind a signed cookie', () => {
  test('creating one writes the row with kind and method and sets a locked-down cookie', async () => {
    const { cookie, res } = await start('owner-1', 'composer');
    const set = res.headers.get('set-cookie')!;
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) expect(set).toContain(part);
    const got = await who(cookie);
    expect(got.session).toMatchObject({ ownerId: 'owner-1', kind: 'composer', method: 'test', createdAt: now, expiresAt: now + 3_600_000 });
    const row = await t.db.prepare('SELECT owner_id, kind, method FROM sessions').first();
    expect(row).toEqual({ owner_id: 'owner-1', kind: 'composer', method: 'test' });
  });

  test('a request without a cookie has no session', async () => {
    expect((await who()).session).toBeNull();
    expect((await who()).reason).toBe('missing');
  });

  test('signing out: the old cookie, sent again, gives no session, and the row is gone', async () => {
    const { cookie } = await start('o', 'composer');
    expect((await who(cookie)).session).not.toBeNull();
    const out = await call('/out', { method: 'POST', headers: { cookie } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await who(cookie)).session).toBeNull();
    expect((await t.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(0);
  });

  test('a forged cookie: a made-up id, a tampered signature and a wrong key all give no session', async () => {
    const { cookie } = await start('o', 'composer');
    const id = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
    const tampered = cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    expect((await who(tampered)).session).toBeNull();
    expect((await who(`sid=${id}`)).session).toBeNull(); // the bare id, unsigned
    const wrongKey = (await serializeSigned('sid', id, 'another-key-that-is-also-32-characters!!', { path: '/' })).split(';')[0]!;
    expect((await who(wrongKey)).session).toBeNull();
    expect((await who(cookie)).session).not.toBeNull();
  });

  test('a validly signed cookie naming no row gives no session', async () => {
    const forged = (await serializeSigned('sid', 'no-such-session', KEY, { path: '/' })).split(';')[0]!;
    expect((await who(forged)).reason).toBe('gone');
  });

  test('an expired session gives no session', async () => {
    const { cookie } = await start('o', 'composer');
    now += 3_599_000;
    expect((await who(cookie)).session).not.toBeNull();
    now += 1_000;
    expect((await who(cookie)).reason).toBe('expired');
  });

  test('revoking every session of one owner leaves other owners alone', async () => {
    const a1 = await start('a', 'composer');
    const a2 = await start('a', 'composer');
    const b = await start('b', 'composer');
    expect(await revokeSessions(t.db, { ownerId: 'a' })).toBe(2);
    expect((await who(a1.cookie)).session).toBeNull();
    expect((await who(a2.cookie)).session).toBeNull();
    expect((await who(b.cookie)).session).not.toBeNull();
  });

  test('revoking by owner and kind removes only that kind; by kind alone removes every owner of it', async () => {
    const admin = await start(null, 'admin');
    const a = await start('a', 'composer');
    const a2 = await start('a', 'other');
    expect(await revokeSessions(t.db, { ownerId: 'a', kind: 'composer' })).toBe(1);
    expect((await who(a.cookie)).session).toBeNull();
    expect((await who(a2.cookie)).session).not.toBeNull();
    expect((await who(admin.cookie)).session).not.toBeNull();
    expect(await revokeSessions(t.db, { kind: 'admin' })).toBe(1);
    expect((await who(admin.cookie)).session).toBeNull();
  });

  test('revoking with no owner and no kind is refused, not "everyone"', async () => {
    await start('a', 'composer');
    await expect(revokeSessions(t.db, {})).rejects.toThrow(TypeError);
    expect((await t.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(1);
  });

  test('a short signing key cannot start a session or read one', async () => {
    const weak = { ...config, secret: 'short' };
    const a = new Hono();
    a.get('/', async c => {
      await createSession(c, t.db, weak, { ownerId: null, kind: 'admin', method: 'x' });
      return c.text('no');
    });
    expect((await a.request('/')).status).toBe(500);
    expect((await readSession({ req: { raw: new Request('https://x.test/') } }, t.db, weak)).session).toBeNull();
  });

  test('purging removes only the expired rows', async () => {
    await start('a', 'composer');
    now += 4_000_000;
    await start('b', 'composer');
    expect(await purgeExpiredSessions(t.db, now)).toBe(1);
    expect((await t.db.prepare('SELECT owner_id FROM sessions').first<{ owner_id: string }>())!.owner_id).toBe('b');
  });
});

describe('a handoff token starts a session once', () => {
  test('first use gives a session for the token owner, method handoff; only the hash is stored', async () => {
    const { token } = await mintHandoffToken(t.db, { ownerId: 'o9', lifetimeSeconds: 60, now: () => now });
    const stored = await t.db.prepare('SELECT token_hash, owner_id, expires_at FROM handoff_tokens').first<any>();
    expect(stored.token_hash).toBe(await sha256Hex(token));
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(token);
    expect(stored.expires_at).toBe(now + 60_000);
    const res = await call(`/exchange?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(await who(cookieOf(res))).toMatchObject({ session: { ownerId: 'o9', kind: 'composer', method: 'handoff' } });
  });

  test('second use, by any browser, is refused and starts no session', async () => {
    const { token } = await mintHandoffToken(t.db, { ownerId: 'o9', lifetimeSeconds: 60, now: () => now });
    expect((await call(`/exchange?token=${token}`)).status).toBe(200);
    const again = await call(`/exchange?token=${token}`);
    expect(again.status).toBe(401);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect((await t.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(1);
  });

  test('too late: refused, no session, and the token is spent', async () => {
    const { token } = await mintHandoffToken(t.db, { ownerId: 'o9', lifetimeSeconds: 60, now: () => now });
    now += 60_000;
    expect((await call(`/exchange?token=${token}`)).status).toBe(401);
    expect((await t.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(0);
    expect((await t.db.prepare('SELECT COUNT(*) AS n FROM handoff_tokens').first<{ n: number }>())!.n).toBe(0);
  });

  test('an unknown or empty token is refused', async () => {
    expect((await call('/exchange?token=nope')).status).toBe(401);
    expect((await call('/exchange')).status).toBe(401);
  });

  test('two exchanges at once give exactly one session', async () => {
    for (let round = 0; round < 5; round++) {
      await t.db.prepare('DELETE FROM sessions').run();
      const { token } = await mintHandoffToken(t.db, { ownerId: 'o9', lifetimeSeconds: 60, now: () => now });
      const results = await Promise.all([call(`/exchange?token=${token}`), call(`/exchange?token=${token}`)]);
      expect(results.map(r => r.status).sort()).toEqual([200, 401]);
      expect((await t.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(1);
    }
  });

  test('a token needs an owner and a positive lifetime', async () => {
    await expect(mintHandoffToken(t.db, { ownerId: '', lifetimeSeconds: 60 })).rejects.toThrow(TypeError);
    await expect(mintHandoffToken(t.db, { ownerId: 'o', lifetimeSeconds: 0 })).rejects.toThrow(TypeError);
  });

  test('unused tokens past their lifetime are purged, live ones kept', async () => {
    await t.db.prepare('DELETE FROM handoff_tokens').run();
    await mintHandoffToken(t.db, { ownerId: 'old', lifetimeSeconds: 60, now: () => now });
    now += 120_000;
    const { token } = await mintHandoffToken(t.db, { ownerId: 'new', lifetimeSeconds: 60, now: () => now });
    expect(await purgeExpiredHandoffTokens(t.db, now)).toBe(1);
    const left = await t.db.prepare('SELECT owner_id FROM handoff_tokens').all<{ owner_id: string }>();
    expect(left.results.map(r => r.owner_id)).toEqual(['new']);
    expect((await call(`/exchange?token=${token}`)).status).toBe(200);
  });
});

describe('resolvePrincipal', () => {
  const adminConfig = { ...config, cookieName: 'koguma_session' };
  const resolver = createPrincipalResolver<{ kind: 'composer'; ownerId: string }>({
    admin: { now: () => now },
    sessions: [
      {
        config: env => ({ ...config, secret: String(env.KOGUMA_SESSION_KEY) }),
        principal: s => (s.kind === 'composer' && s.ownerId ? { kind: 'composer', ownerId: s.ownerId } : null)
      }
    ]
  });
  const env = () => ({ DB: t.db, KOGUMA_SESSION_KEY: KEY }) as Record<string, unknown>;
  const req = (cookie?: string) => new Request('https://x.test/', { headers: cookie ? { cookie } : {} });

  test('an admin session is admin, another kind goes through the host mapping, nothing is null', async () => {
    const admin = await start(null, 'admin'); // sid cookie: not the admin cookie name
    const composer = await start('o1', 'composer');
    expect(await resolver(req(composer.cookie), env())).toEqual({ kind: 'composer', ownerId: 'o1' });
    // an admin-kind session in the host's own cookie is not trusted as admin through it
    expect(await resolver(req(admin.cookie), env())).toBeNull();
    expect(await resolver(req(), env())).toBeNull();
    await t.db.prepare('INSERT INTO sessions VALUES (?, NULL, ?, ?, ?, ?)').bind('adm1', 'admin', 'password', now, now + 1000).run();
    const signed = (await serializeSigned('koguma_session', 'adm1', KEY, { path: '/' })).split(';')[0]!;
    expect(await resolver(req(signed), env())).toEqual({ kind: 'admin' });
    void adminConfig;
  });

  test('a mapping that returns null refuses, and a revoked session resolves to null', async () => {
    const other = await start('o2', 'other');
    expect(await resolver(req(other.cookie), env())).toBeNull();
    const composer = await start('o3', 'composer');
    await revokeSessions(t.db, { ownerId: 'o3' });
    expect(await resolver(req(composer.cookie), env())).toBeNull();
  });
});
