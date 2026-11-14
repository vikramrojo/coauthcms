/** Task 6.6: the admin's own sign-in page and its three forms, for a host whose credential is a cookie. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAdmin, type AdminSession } from '../src/admin/index.ts';
import { admin, type World } from './sample.ts';
import { createAdminWorld, ORIGIN } from './admin-support.ts';

let w: World;
beforeEach(async () => {
  w = await createAdminWorld();
});
afterEach(() => w.dispose());

const PASSWORD = 'open sesame';
const COOKIE = 'sess=yes';
const calls: string[] = [];

/** A host whose sign-in is a cookie named `sess`. */
const session: AdminSession = {
  async signIn(c, password) {
    calls.push('signIn');
    if (password === 'busy') return new Response('{}', { status: 429 });
    if (password === 'broken') return new Response('{}', { status: 500 });
    return password === PASSWORD ? new Response('{}', { status: 200, headers: { 'set-cookie': `${COOKIE}; Path=/; HttpOnly` } }) : new Response('{}', { status: 401 });
  },
  async signOut() {
    calls.push('signOut');
    return new Response('{}', { status: 200, headers: { 'set-cookie': 'sess=; Path=/; Max-Age=0' } });
  },
  async signOutEverywhere() {
    calls.push('signOutEverywhere');
    return new Response('{}', { status: 200, headers: { 'set-cookie': 'sess=; Path=/; Max-Age=0' } });
  }
};

function host(options: { session?: AdminSession } = { session }) {
  const app = new Hono();
  app.route(
    '/admin',
    createAdmin<any>({
      cms: w.cms as never,
      resolvePrincipal: c => (c.req.header('cookie')?.includes(COOKIE) ? (admin('operator') as never) : null),
      mount: '/admin',
      siteName: 'Test',
      ...options
    })
  );
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString()
    });
  return { request, post };
}

describe('a caller who is not signed in', () => {
  test('gets the sign-in page, 401, for any page, with a password form that posts to the admin and no script needed', async () => {
    const { request } = host();
    for (const path of ['/admin', '/admin/t/page', '/admin/x/anything', '/admin/t/page/abc/delete']) {
      const res = await request(path);
      expect(res.status, path).toBe(401);
      const body = await res.text();
      expect(body).toContain('<form method="post" action="/admin/sign-in"');
      expect(body).toContain('type="password" name="password"');
      expect(body).not.toContain('Sign out');
    }
    // The form remembers where the caller was going.
    expect(await (await request('/admin/t/page?q=a')).text()).toContain('name="next" value="/admin/t/page?q=a"');
  });

  test('without a session option the answer is the plain 401 and there are no sign-in routes', async () => {
    const { request, post } = host({});
    const res = await request('/admin');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('type="password"');
    expect((await post('/admin/sign-in', { password: PASSWORD })).status).toBe(401);
  });

  test('the sign-in page carries the admin\'s CSP and no cache', async () => {
    const res = await host().request('/admin');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('signing in', () => {
  test('the right password sets the host\'s cookie and goes to the admin\'s first page', async () => {
    const { post } = host();
    const res = await post('/admin/sign-in', { password: PASSWORD, next: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    expect(res.headers.get('set-cookie')).toContain(COOKIE);
  });

  test('goes back to the page asked for, when it is a page of this admin', async () => {
    const { post } = host();
    expect((await post('/admin/sign-in', { password: PASSWORD, next: '/admin/t/page?q=a' })).headers.get('location')).toBe('/admin/t/page?q=a');
    for (const next of ['https://evil.example/admin', '//evil.example', '/elsewhere', '/admin\\evil', '/admin/\r\nx: y', 'admin/t/page', '/administrator']) {
      expect((await post('/admin/sign-in', { password: PASSWORD, next })).headers.get('location'), next).toBe('/admin');
    }
  });

  test('a wrong password is 401 on the form again, with a message, and sets no cookie', async () => {
    const { post } = host();
    const res = await post('/admin/sign-in', { password: 'nope', next: '/admin/t/page' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.text();
    expect(body).toContain('That password is not right.');
    expect(body).toContain('name="next" value="/admin/t/page"');
  });

  test('too many tries is 429, and any other failure a 500 that says sign-in is unavailable; an empty password never reaches the host', async () => {
    const { post } = host();
    calls.length = 0;
    const busy = await post('/admin/sign-in', { password: 'busy' });
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain('Too many tries');
    const broken = await post('/admin/sign-in', { password: 'broken' });
    expect(broken.status).toBe(500);
    expect(await broken.text()).toContain('not available');
    expect((await post('/admin/sign-in', { password: '' })).status).toBe(401);
    expect(calls).toEqual(['signIn', 'signIn']);
  });

  test('a post from another site is refused', async () => {
    const res = await host().post('/admin/sign-in', { password: PASSWORD }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  test('a signed-in caller opening the sign-in address goes home', async () => {
    const res = await host().request('/admin/sign-in', { headers: { cookie: COOKIE } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
  });
});

describe('signing out', () => {
  test('a signed-in page carries Sign out and Sign out everywhere, posting to the admin', async () => {
    const body = await (await host().request('/admin', { headers: { cookie: COOKIE } })).text();
    expect(body).toContain('<form method="post" action="/admin/sign-out">');
    expect(body).toContain('<form method="post" action="/admin/sign-out-everywhere">');
  });

  test('Sign out passes the host\'s cookie change on and goes home, which then asks for the password', async () => {
    const { post } = host();
    calls.length = 0;
    const res = await post('/admin/sign-out', {}, { cookie: COOKIE });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(calls).toEqual(['signOut']);
  });

  test('Sign out works for a caller whose session is already gone', async () => {
    expect((await host().post('/admin/sign-out', {})).status).toBe(303);
  });

  test('Sign out everywhere needs a signed-in caller and passes the cookie change on', async () => {
    const { post } = host();
    calls.length = 0;
    expect((await post('/admin/sign-out-everywhere', {})).status).toBe(401);
    expect(calls).toEqual([]);
    const res = await post('/admin/sign-out-everywhere', {}, { cookie: COOKIE });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(calls).toEqual(['signOutEverywhere']);
  });

  test('a post that is not a form is refused before it reaches the host', async () => {
    const res = await host().request('/admin/sign-out', { method: 'POST', headers: { origin: ORIGIN, cookie: COOKIE } });
    expect(res.status).toBe(415);
  });
});
