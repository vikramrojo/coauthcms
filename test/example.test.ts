/**
 * The example Worker (examples/worker) bundled as a host would ship it and run in Miniflare: a member creates a note,
 * another member lists and sees none, the first lists and sees one; the admin is mounted and keeps out a stranger.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { statements } from './support.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const ENV = {
  KOGUMA_SECRET: 'operator-password-for-the-test',
  KOGUMA_SESSION_KEY: 'operator-session-key-0123456789abcdef-aaaa',
  MEMBER_SESSION_KEY: 'member-session-key-0123456789abcdef-bbbbb'
};

let mf: Miniflare;
let script = '';

async function worker(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return mf.dispatchFetch(`https://example.test${path}`, { ...init, headers, redirect: 'manual' } as never) as unknown as Promise<Response>;
}

/** The cookie a response sets, as a request's Cookie header. */
const cookieOf = (response: Response) => (response.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${ROOT}examples/worker/src/index.ts`],
    target: 'browser',
    format: 'esm',
    minify: true
  });
  if (!built.success) throw new Error(built.logs.join('\n'));
  script = await built.outputs[0]!.text();
  mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-03-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'example-db' },
    bindings: ENV
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  // What a host's `wrangler d1 migrations apply` does: the example's own migrations folder, in order.
  for (const file of ['0001_entries.sql', '0002_sessions.sql']) {
    const text = readFileSync(`${ROOT}examples/worker/migrations/${file}`, 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    for (const statement of text.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}, 60_000);

afterAll(() => mf?.dispose());

/** The operator signs in and asks for a one-time token for `id`; the member's browser exchanges it for a session cookie. */
async function signInMember(id: string): Promise<string> {
  const login = await worker('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: ENV.KOGUMA_SECRET }) });
  expect(login.status).toBe(200);
  const adminCookie = cookieOf(login);
  const minted = await worker(`/handoff/${id}`, { method: 'POST' }, adminCookie);
  expect(minted.status).toBe(200);
  const { token } = (await minted.json()) as { token: string };
  const exchanged = await worker(`/signin?token=${encodeURIComponent(token)}`);
  expect(exchanged.status).toBe(200);
  const cookie = cookieOf(exchanged);
  expect(cookie).toContain('member_session=');
  // A token is used once.
  expect((await worker(`/signin?token=${encodeURIComponent(token)}`)).status).toBe(401);
  return cookie;
}

describe('the example worker', () => {
  test('a note is its member’s: the other sees none, the owner sees one', async () => {
    const ada = await signInMember('ada');
    const bob = await signInMember('bob');

    const created = await worker('/notes', { method: 'POST', body: JSON.stringify({ title: 'First', body: 'Hello **there**' }) }, ada);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ title: 'First', body: 'Hello **there**' });

    const bobs = await worker('/notes', {}, bob);
    expect(await bobs.json()).toEqual({ notes: [] });

    const adas = (await (await worker('/notes', {}, ada)).json()) as { notes: { title: string }[] };
    expect(adas.notes.map(n => n.title)).toEqual(['First']);
  });

  test('a caller with no session is refused, and a forged member cookie is no session', async () => {
    expect((await worker('/notes')).status).toBe(401);
    expect((await worker('/notes', {}, 'member_session=forged')).status).toBe(401);
    expect((await worker('/handoff/ada', { method: 'POST' })).status).toBe(403);
  });

  test('a note is stored with its member as owner', async () => {
    const cookie = await signInMember('carol');
    const response = await worker('/notes', { method: 'POST', body: JSON.stringify({ title: 'Mine' }) }, cookie);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const db = (await mf.getD1Database('DB')) as unknown as D1Database;
    expect(await db.prepare('SELECT owner_id, content_type FROM entries WHERE id = ?').bind(id).first()).toEqual({ owner_id: 'carol', content_type: 'note' });
  });

  test('the admin is mounted at /admin: a stranger gets the sign-in page, the operator the type list', async () => {
    const stranger = await worker('/admin');
    expect(stranger.status).toBe(401);
    expect(await stranger.text()).toContain('password');

    const login = await worker('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: ENV.KOGUMA_SECRET }) });
    const page = await worker('/admin', {}, cookieOf(login));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Notes');
  });

  test('the bundle holds no React and stays small', () => {
    expect(script).not.toMatch(/react-dom|createElement\("div"/);
    expect(gzipSync(script).length).toBeLessThan(300 * 1024);
  });
});

test('the example’s migrations folder holds the package’s own files, unchanged', () => {
  const same = (a: string, b: string) => expect(statements(a)).toEqual(
    readFileSync(`${ROOT}examples/worker/migrations/${b}`, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)
  );
  same('0001_entries.sql', '0001_entries.sql');
  same('auth/0001_sessions.sql', '0002_sessions.sql');
});
