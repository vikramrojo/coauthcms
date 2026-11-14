/**
 * The smallest useful coauthcms host: one owned type (a `note` with a title and a body, one owner per row), a
 * host principal kind `member` resolved from a session cookie, the admin at /admin, and two JSON routes that create
 * and list the caller's own notes through `content.as`.
 *
 * Members sign in by handoff: something you trust (your app, an email link) asks for a one-time token for a member id
 * (`POST /handoff/:member`, admin only here, standing in for your own sign-in) and the browser exchanges it for a
 * session at `GET /signin?token=...`. The operator signs in at /admin with the password in `KOGUMA_SECRET`.
 */
import { Hono, type Context } from 'hono';
import { contentType, createCms, field, type AccessContext, type Cms, type Principal } from 'coauthcms';
import { createAdmin, type AdminSession } from 'coauthcms/admin';
import {
  createPrincipalResolver,
  exchangeHandoffToken,
  mintHandoffToken,
  passwordRoutes,
  type SessionConfig
} from 'coauthcms/auth';

export interface Env {
  DB: D1Database;
  /** The operator's password (the admin sign-in). */
  KOGUMA_SECRET: string;
  /** Signs the operator's session cookie; 32 characters or more, never the password. */
  KOGUMA_SESSION_KEY: string;
  /** Signs the members' session cookie; 32 characters or more. */
  MEMBER_SESSION_KEY: string;
}

/** The host's own kind of caller. `memberId` is whatever your members are called; the store only compares it. */
export interface Member {
  kind: 'member';
  memberId: string;
}

export const note = contentType({
  id: 'note',
  name: 'Notes',
  displayField: 'title',
  owned: true,
  fields: {
    title: field.text('Title').required().max(200),
    body: field.markdown('Body')
  },
  access(principal: Principal<Member>, { can }: AccessContext) {
    if (principal.kind === 'member') {
      const own = { owner_id: principal.memberId };
      can('read', { where: own });
      can(['update', 'delete'], { where: own });
      can('create', { where: own });
    }
    if (principal.kind === 'admin') {
      can('read');
      can('delete');
    }
  }
});

const instances = new WeakMap<D1Database, Cms<Member>>();

/** One store per database binding: startup compiles every rule against a sample member and checks the columns once. */
export function cmsFor(db: D1Database): Cms<Member> {
  let cms = instances.get(db);
  if (!cms) {
    cms = createCms<Member>({ db, types: [note], probes: [{ kind: 'member', memberId: 'probe' }] });
    instances.set(db, cms);
  }
  return cms;
}

const memberSession = (env: Env): SessionConfig => ({
  cookieName: 'member_session',
  secret: env.MEMBER_SESSION_KEY,
  lifetimeSeconds: 7 * 24 * 60 * 60
});

const resolvePrincipal = createPrincipalResolver<Member>({
  sessions: [
    {
      config: env => memberSession(env as unknown as Env),
      principal: session => (session.kind === 'member' && session.ownerId ? { kind: 'member', memberId: session.ownerId } : null)
    }
  ]
});

const passwords = passwordRoutes();

/** The admin's three sign-in forms, answered by the package's own password routes. */
function through(c: Context, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const address = c.req.header('CF-Connecting-IP');
  if (address) headers['CF-Connecting-IP'] = address;
  const cookie = c.req.header('cookie');
  if (cookie) headers.cookie = cookie;
  return Promise.resolve(passwords.request(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }, c.env));
}

const adminSession: AdminSession = {
  signIn: (c, password) => through(c, '/login', { password }),
  signOut: c => through(c, '/logout'),
  signOutEverywhere: c => through(c, '/logout-all')
};

const app = new Hono<{ Bindings: Env }>();

const admins = new WeakMap<D1Database, Hono>();

/** The admin for this binding's store, mounted at /admin. Built once per binding. */
function adminFor(env: Env): Hono {
  let host = admins.get(env.DB);
  if (!host) {
    host = new Hono().route(
      '/admin',
      createAdmin<Member>({
        cms: cmsFor(env.DB),
        // Only the operator's session opens the admin; a member's cookie is no admin.
        resolvePrincipal: async c => {
          const who = await resolvePrincipal(c.req.raw, c.env as Record<string, unknown>);
          return who?.kind === 'admin' ? { kind: 'admin' } : null;
        },
        mount: '/admin',
        siteName: 'Notes',
        session: adminSession
      })
    );
    admins.set(env.DB, host);
  }
  return host;
}

app.all('/admin', c => adminFor(c.env).fetch(c.req.raw, c.env, c.executionCtx));
app.all('/admin/*', c => adminFor(c.env).fetch(c.req.raw, c.env, c.executionCtx));
app.route('/api/auth', passwords);

/** Members sign in here with a handoff token. */
app.get('/signin', async c => {
  const session = await exchangeHandoffToken(c, c.env.DB, memberSession(c.env), c.req.query('token') ?? '', 'member');
  return session ? c.json({ ok: true }) : c.json({ error: 'invalid_token' }, 401);
});

/** Stands in for your own sign-in: the operator asks for a one-time token for a member id. */
app.post('/handoff/:member', async c => {
  const who = await resolvePrincipal(c.req.raw, c.env as unknown as Record<string, unknown>);
  if (who?.kind !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const { token } = await mintHandoffToken(c.env.DB, { ownerId: c.req.param('member'), lifetimeSeconds: 120 });
  return c.json({ token });
});

/** The caller of a JSON route: a member, or a 401. */
async function member(c: Context<{ Bindings: Env }>): Promise<Member | null> {
  const who = await resolvePrincipal(c.req.raw, c.env as unknown as Record<string, unknown>);
  return who?.kind === 'member' ? who : null;
}

app.post('/notes', async c => {
  const me = await member(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ title?: string; body?: string }>();
  const created = await cmsFor(c.env.DB).content.as(me).create('note', { title: body.title, body: body.body, owner_id: me.memberId });
  return c.json({ id: created.id, ...created.data }, 201);
});

app.get('/notes', async c => {
  const me = await member(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  const notes = await cmsFor(c.env.DB).content.as(me).list('note');
  return c.json({ notes: notes.map(n => ({ id: n.id, ...n.data })) });
});

app.onError((error, c) => {
  const status = (error as { status?: number }).status;
  return c.json({ error: error.name, message: error.message }, typeof status === 'number' ? (status as 400) : 500);
});

export default app;
