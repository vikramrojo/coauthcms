/**
 * createAdmin: the admin's routes as a Hono app for the host to mount where it
 * likes. Every read and write of entries goes through `cms.content.as(principal)`
 * for the principal the host resolved, so the admin can do nothing the type's
 * rules refuse that caller; `cms.access.rulesFor` only decides what to draw.
 *
 *   app.route('/admin2', createAdmin({ cms, resolvePrincipal, mount: '/admin2' }))
 *
 * Writes are forms that POST and answer 303. They are refused unless they are
 * form posts from the admin's own origin (hono/csrf, plus a content-type check,
 * since csrf looks only at form content types), and every page carries a content
 * security policy that names the admin's script, the editor and the stylesheets.
 */
import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import {
  ConfigError, Conflict, Forbidden, ValidationError, WriteRefused,
  type ContentType, type Entry, type FieldMeta, type HostPrincipal, type Principal, type PackedRules, type Where
} from '../core/index.ts';
import { ADMIN_CSS, ADMIN_JS } from './assets.ts';
import type { ResolveRef } from './fields.ts';
import { parseForm } from './forms.ts';
import { can, mayWrite, mayWriteColumn, ruleRow, writable, type Writable } from './rules.ts';
import type { AdminAction, AdminAssets, AdminOptions, ExternalCollection, ExternalRow } from './types.ts';
import {
  confirmPage, entryListPage, entryPage, externalListPage, externalRowPage, messagePage, noticeText, signInPage, typeListPage,
  type Column, type Row, type Shell
} from './views.ts';

export const DEFAULT_ASSETS: AdminAssets = {
  largen: '/largen.css',
  largenDark: '/largen-theme-dark.css',
  editor: '/admin-editor.js',
  editorStyles: '/admin-editor.css',
  editorStylesDark: '/admin-editor-dark.css'
};

const PAGE = 50;
const FORM = /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;
/** Most rows offered in a target picker. */
const PICKER_CAP = 2000;

const status = (error: unknown, fallback: number): number => {
  const n = (error as { status?: unknown } | null)?.status;
  return typeof n === 'number' && n >= 400 && n < 600 ? n : fallback;
};

export function createAdmin<H extends HostPrincipal = never>(options: AdminOptions<H>): Hono<any> {
  type P = Principal<H>;
  type Ctx = Context<{ Variables: { principal: P } }>;

  const { cms } = options;
  const mount = options.mount.replace(/\/+$/, '');
  const assets: AdminAssets = { ...DEFAULT_ASSETS, ...options.assets };
  const shell: Shell = { mount, home: mount || '/', siteName: options.siteName ?? 'Admin', assets, session: Boolean(options.session) };
  const externals = new Map((options.externalCollections ?? []).map(c => [c.id, c]));
  const typeActions = options.typeActions ?? {};

  const app = new Hono<{ Variables: { principal: P } }>();

  // ── Headers, assets, write checks, caller ─────────────────────────

  const absolute = (c: Context, url: string) => (/^https?:\/\//i.test(url) ? url : new URL(url, c.req.url).href);
  const own = (...urls: string[]) => urls.map(url => (c: Context) => absolute(c, url));
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: own(`${mount}/assets/admin.js`, assets.editor),
        styleSrc: own(assets.largen, assets.largenDark, `${mount}/assets/admin.css`, assets.editorStyles, assets.editorStylesDark),
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"]
      },
      referrerPolicy: 'no-referrer'
    })
  );
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'private, no-store');
  });

  const asset = (type: string, body: string) => (c: Context) =>
    c.body(body, 200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
  app.get('/assets/admin.css', asset('text/css; charset=utf-8', ADMIN_CSS));
  app.get('/assets/admin.js', asset('text/javascript; charset=utf-8', ADMIN_JS));

  // A write is a form post. csrf checks only form content types, so a post of anything else (a bare fetch with no
  // body, say) is refused here, before it can pass for no form at all.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !FORM.test(c.req.header('content-type') ?? '')) {
      return c.html(messagePage(shell, 'Not accepted', 'The admin takes form posts only.'), 415);
    }
    await next();
  });
  app.use('*', csrf());

  // ── Sign-in (only when the host gave a session) ───────────────────

  /** Where to go after signing in: a page of this admin, never another site. */
  const safeNext = (value: unknown): string => {
    const next = typeof value === 'string' ? value : '';
    return (next === mount || next.startsWith(`${mount}/`)) && !next.startsWith('//') && !/[\\\r\n]/.test(next) ? next : shell.home;
  };
  /** A redirect that carries the cookies the host's answer set. */
  const withCookies = (c: Context, from: Response, to: string) => {
    for (const cookie of from.headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
    return c.redirect(to, 303);
  };
  const signedOutPage = (c: Context, next: string, error?: string, status: 200 | 401 | 429 | 500 = 401) =>
    c.html(signInPage(shell, next, error), status);
  const session = options.session;
  if (session) {
    app.post('/sign-in', async c => {
      const body = await c.req.parseBody();
      const next = safeNext(body.next);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password) return signedOutPage(c, next, 'Enter the password.');
      const answer = await session.signIn(c, password);
      if (answer.ok) return withCookies(c, answer, next);
      const message =
        answer.status === 401 ? 'That password is not right.'
        : answer.status === 429 ? 'Too many tries. Wait a while and try again.'
        : 'Sign-in is not available right now.';
      return signedOutPage(c, next, message, answer.status === 401 || answer.status === 429 ? answer.status : 500);
    });
    // Signing out needs no sign-in: it ends whatever session the request carries.
    app.post('/sign-out', async c => withCookies(c, await session.signOut(c), shell.home));
  }

  app.use('*', async (c, next) => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) {
      if (session) {
        const url = new URL(c.req.url);
        return signedOutPage(c, c.req.method === 'GET' ? safeNext(url.pathname + url.search) : shell.home);
      }
      return options.unauthorized ? options.unauthorized(c) : c.html(messagePage(shell, 'Sign in', 'You are not signed in.'), 401);
    }
    c.set('principal', principal);
    await next();
  });

  if (session) {
    app.post('/sign-out-everywhere', async c => withCookies(c, await session.signOutEverywhere(c), shell.home));
    // A signed-in caller who opens the sign-in address goes home.
    app.get('/sign-in', c => c.redirect(shell.home, 303));
  }

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof Forbidden) return c.html(messagePage(shell, 'Not allowed', error.message, { label: 'Back', href: shell.home }), 403);
    if (error instanceof WriteRefused) return c.html(messagePage(shell, 'Refused', error.message, { label: 'Back', href: shell.home }), 422);
    if (error instanceof ValidationError || error instanceof Conflict) {
      return c.html(messagePage(shell, 'Not saved', error.message, { label: 'Back', href: shell.home }), error instanceof Conflict ? 409 : 422);
    }
    if (!(error instanceof ConfigError)) console.error(error);
    else console.error(error.message);
    return c.html(messagePage(shell, 'Something went wrong', 'The request could not be completed.'), 500);
  });

  // ── Lookups ───────────────────────────────────────────────────────

  const principalOf = (c: Ctx) => c.get('principal');
  const rulesOf = (c: Ctx): PackedRules => cms.access.rulesFor(principalOf(c));
  const apiOf = (c: Ctx) => cms.content.as(principalOf(c));
  const notFound = (c: Ctx) => c.html(messagePage(shell, 'Not found', 'There is nothing here.', { label: 'Back to the list', href: shell.home }), 404);

  /** A stored type the caller may read, else undefined (a type they may not read looks like one that does not exist). */
  const readable = (c: Ctx, id: string): ContentType<any> | undefined => {
    const type = cms.types.get(id);
    return type && !type.service && can(rulesOf(c), id, 'read') ? type : undefined;
  };
  const external = (c: Ctx, id: string): ExternalCollection<H> | undefined => {
    const collection = externals.get(id);
    return collection && allowed(collection, principalOf(c)) ? collection : undefined;
  };
  const allowed = (collection: ExternalCollection<H>, principal: P) =>
    collection.allow ? collection.allow(principal) : principal.kind === 'admin';

  const notice = (c: Ctx) => noticeText(c.req.query('notice'));
  const label = (type: ContentType<any>, e: Entry) => String(e.data[type.displayField] ?? '') || e.slug || e.id;

  /** Where each reference field's ids lead and what to call them. Reads only what the caller may read. */
  async function resolver(c: Ctx, fields: Record<string, FieldMeta>, data: Record<string, unknown>): Promise<ResolveRef> {
    const wanted = new Map<string, Set<string>>();
    for (const [name, meta] of Object.entries(fields)) {
      if ((meta.fieldType !== 'reference' && meta.fieldType !== 'references') || !meta.refContentType) continue;
      const value = data[name];
      const ids = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      const set = wanted.get(meta.refContentType) ?? new Set<string>();
      for (const id of ids) if (typeof id === 'string') set.add(id);
      wanted.set(meta.refContentType, set);
    }
    const names = new Map<string, string>();
    for (const [refType, ids] of wanted) {
      const list = [...ids].slice(0, 90);
      if (list.length === 0) continue;
      const type = readable(c, refType);
      const collection = external(c, refType);
      if (type) {
        for (const e of await apiOf(c).list(refType, { where: { id: { in: list } }, limit: 90 })) names.set(`${refType}:${e.id}`, label(type, e));
      } else if (collection) {
        for (const id of list.slice(0, 20)) {
          const row = await collection.get(c, id);
          if (row) names.set(`${refType}:${id}`, String(row[collection.displayField] ?? '') || id);
        }
      }
    }
    return (refType, id) => {
      const href = readable(c, refType) ? `${mount}/t/${refType}/${encodeURIComponent(id)}` : external(c, refType) ? `${mount}/x/${refType}/${encodeURIComponent(id)}` : null;
      return { href, label: names.get(`${refType}:${id}`) ?? id };
    };
  }

  // ── Types ─────────────────────────────────────────────────────────

  app.get('/', c => {
    const rules = rulesOf(c);
    const stored = [...cms.types.values()].filter(t => !t.service && can(rules, t.id, 'read')).map(t => ({ id: t.id, name: t.name }));
    const outside = [...externals.values()].filter(x => allowed(x, principalOf(c))).map(x => ({ id: x.id, name: x.name }));
    return c.html(typeListPage(shell, stored, outside));
  });

  // ── Entry lists ───────────────────────────────────────────────────

  app.get('/t/:type', async c => {
    const type = readable(c, c.req.param('type'));
    if (!type) return notFound(c);
    const q = (c.req.query('q') ?? '').trim();
    const statusFilter = c.req.query('status') === 'published' || c.req.query('status') === 'draft' ? c.req.query('status')! : '';
    const owner = (c.req.query('owner') ?? '').trim();
    const offset = Math.max(Math.trunc(Number(c.req.query('offset') ?? 0)) || 0, 0);
    const conditions: Where[] = [];
    // The store's conditions are equality, so a slug search is exact.
    if (q) conditions.push({ slug: q });
    if (statusFilter) conditions.push({ status: statusFilter });
    if (owner && type.owned) conditions.push({ owner_id: owner });
    const found = await apiOf(c).list(type.id, {
      ...(conditions.length === 0 ? {} : { where: conditions.length === 1 ? conditions[0]! : { and: conditions } }),
      orderBy: 'updated_at',
      direction: 'desc',
      limit: PAGE + 1,
      offset
    });
    return c.html(
      entryListPage(shell, {
        type,
        entries: found.slice(0, PAGE),
        q,
        status: statusFilter,
        owner: type.owned ? owner : '',
        offset,
        limit: PAGE,
        hasNext: found.length > PAGE,
        canCreate: can(rulesOf(c), type.id, 'create'),
        notice: notice(c)
      })
    );
  });

  // ── One entry ─────────────────────────────────────────────────────

  interface FormState {
    values?: Record<string, unknown>;
    problems?: string[];
    fieldErrors?: Record<string, string>;
  }

  async function renderEntry(c: Ctx, type: ContentType<any>, entry: Entry | undefined, state: FormState = {}) {
    const rules = rulesOf(c);
    const operation = entry ? 'update' : 'create';
    const row = entry ? ruleRow(type, entry) : undefined;
    const w: Writable = writable(rules, type.id, operation, row);
    const shown = (name: string) => (state.values && name in state.values ? state.values[name] : entry?.data[name]);
    const columns: Column[] = [];
    if (entry) {
      columns.push({ label: 'Id', name: 'id', value: entry.id, editable: false });
      columns.push({ label: 'Status', name: 'status', value: entry.status, editable: false });
    }
    const slugText = state.values && 'slug' in state.values ? (state.values.slug as string | null) : (entry?.slug ?? null);
    if (entry || mayWriteColumn(w, 'slug', 'create')) {
      columns.push({ label: 'Slug', name: 'slug', value: slugText, editable: mayWriteColumn(w, 'slug', operation) });
    }
    if (type.owned && (entry || mayWriteColumn(w, 'owner_id', 'create'))) {
      const ownerText = state.values && 'owner_id' in state.values ? (state.values.owner_id as string | null) : (entry?.owner_id ?? null);
      columns.push({ label: 'Owner', name: 'owner_id', value: ownerText, editable: mayWriteColumn(w, 'owner_id', operation) });
    }
    if (entry) {
      columns.push({ label: 'Created', name: 'created_at', value: entry.created_at, editable: false });
      columns.push({ label: 'Updated', name: 'updated_at', value: entry.updated_at, editable: false });
    }
    const rows: Row[] = [];
    for (const [name, meta] of Object.entries(type.fieldMeta)) {
      const editable = mayWrite(w, name, meta);
      if (!entry && !editable) continue;
      rows.push({ name, meta, value: shown(name), editable, error: state.fieldErrors?.[name] });
    }
    const data = Object.fromEntries(Object.keys(type.fieldMeta).map(name => [name, shown(name)]));
    const refs = await resolver(c, type.fieldMeta, data);
    const actions = entry
      ? (typeActions[type.id] ?? []).filter(a => (a.requires ? can(rules, type.id, a.requires, row) : true))
      : [];
    return entryPage(shell, {
      type,
      entry,
      columns,
      rows,
      refs,
      canSave: columns.some(col => col.editable) || rows.some(r => r.editable),
      canPublish: !!entry && can(rules, type.id, 'publish', row),
      // A type's own `unpublish` and `delete` actions take the place of the plain controls.
      canUnpublish: !!entry && can(rules, type.id, 'publish', row) && !(typeActions[type.id] ?? []).some(a => a.id === 'unpublish'),
      canDelete: !!entry && can(rules, type.id, 'delete', row) && !(typeActions[type.id] ?? []).some(a => a.id === 'delete'),
      actions,
      notice: notice(c),
      problems: state.problems
    });
  }

  /** What went wrong with a write, as page text, when the page can be shown again with the values typed. */
  const problemsOf = (error: unknown): { problems: string[]; fieldErrors: Record<string, string>; status: 409 | 422 } | null => {
    if (error instanceof ValidationError) {
      return {
        problems: error.issues.map(i => `${i.field} ${i.message}`),
        fieldErrors: Object.fromEntries(error.issues.map(i => [i.field, i.message])),
        status: 422
      };
    }
    if (error instanceof Conflict) return { problems: [error.message], fieldErrors: {}, status: 409 };
    if (error instanceof WriteRefused) return { problems: [error.message], fieldErrors: {}, status: 422 };
    return null;
  };

  app.get('/t/:type/new', async c => {
    const type = readable(c, c.req.param('type'));
    if (!type || !can(rulesOf(c), type.id, 'create')) return notFound(c);
    return c.html(await renderEntry(c, type, undefined));
  });

  app.post('/t/:type', async c => {
    const type = readable(c, c.req.param('type'));
    if (!type) return notFound(c);
    const { values, errors } = parseForm(type, await c.req.formData());
    if (errors.length === 0) {
      try {
        const created = await apiOf(c).create(type.id, values);
        return c.redirect(`${mount}/t/${type.id}/${encodeURIComponent(created.id)}?notice=created`, 303);
      } catch (error) {
        const shown = problemsOf(error);
        if (!shown) throw error;
        return c.html(await renderEntry(c, type, undefined, { values, ...shown }), shown.status);
      }
    }
    return c.html(
      await renderEntry(c, type, undefined, {
        values,
        problems: errors.map(e => `${e.field} ${e.message}`),
        fieldErrors: Object.fromEntries(errors.map(e => [e.field, e.message]))
      }),
      422
    );
  });

  const entryOf = async (c: Ctx) => {
    const type = readable(c, c.req.param('type') ?? '');
    if (!type) return {};
    const entry = await apiOf(c).get(type.id, c.req.param('id') ?? '');
    return entry ? { type, entry } : {};
  };

  app.get('/t/:type/:id', async c => {
    const { type, entry } = await entryOf(c);
    if (!type || !entry) return notFound(c);
    return c.html(await renderEntry(c, type, entry));
  });

  app.post('/t/:type/:id', async c => {
    const { type, entry } = await entryOf(c);
    if (!type || !entry) return notFound(c);
    const { values, errors } = parseForm(type, await c.req.formData());
    if (errors.length === 0) {
      try {
        // Every posted field goes to the store as posted; a field the caller may not write is refused there.
        await apiOf(c).update(type.id, entry.id, values);
        return c.redirect(`${mount}/t/${type.id}/${encodeURIComponent(entry.id)}?notice=saved`, 303);
      } catch (error) {
        const shown = problemsOf(error);
        if (!shown) throw error;
        return c.html(await renderEntry(c, type, entry, { values, ...shown }), shown.status);
      }
    }
    return c.html(
      await renderEntry(c, type, entry, {
        values,
        problems: errors.map(e => `${e.field} ${e.message}`),
        fieldErrors: Object.fromEntries(errors.map(e => [e.field, e.message]))
      }),
      422
    );
  });

  for (const verb of ['publish', 'unpublish'] as const) {
    app.post(`/t/:type/:id/${verb}`, async c => {
      const { type, entry } = await entryOf(c);
      if (!type || !entry) return notFound(c);
      await apiOf(c)[verb](type.id, entry.id);
      return c.redirect(`${mount}/t/${type.id}/${encodeURIComponent(entry.id)}?notice=${verb === 'publish' ? 'published' : 'unpublished'}`, 303);
    });
  }

  app.get('/t/:type/:id/delete', async c => {
    const { type, entry } = await entryOf(c);
    if (!type || !entry) return notFound(c);
    if (!can(rulesOf(c), type.id, 'delete', ruleRow(type, entry))) return notFound(c);
    const name = label(type, entry);
    return c.html(
      confirmPage(shell, {
        title: `Delete ${name}?`,
        question: `Delete “${name}”? This cannot be undone.`,
        action: `${mount}/t/${type.id}/${encodeURIComponent(entry.id)}/delete`,
        confirmLabel: 'Delete',
        destructive: true,
        cancel: `${mount}/t/${type.id}/${encodeURIComponent(entry.id)}`,
        crumbs: [{ label: type.name, href: `${mount}/t/${type.id}` }, { label: name }]
      })
    );
  });

  app.post('/t/:type/:id/delete', async c => {
    const { type, entry } = await entryOf(c);
    if (!type || !entry) return notFound(c);
    await apiOf(c).remove(type.id, entry.id);
    return c.redirect(`${mount}/t/${type.id}?notice=deleted`, 303);
  });

  // ── Actions, on a store type's entries and on external rows ───────

  /** The rows an action may be aimed at: another entry of the target type, as the caller may read them. */
  async function targetOptions(c: Ctx, targetId: string, selfId: string): Promise<{ title: string; options: { id: string; label: string }[] } | null> {
    const collection = external(c, targetId);
    const options: { id: string; label: string }[] = [];
    if (collection) {
      for (let offset = 0; offset < PICKER_CAP; offset += 200) {
        const rows = await collection.list(c, { limit: 200, offset });
        for (const row of rows) {
          if (row.id !== selfId && (collection.pickable ? collection.pickable(row) : true)) {
            options.push({ id: row.id, label: String(row[collection.displayField] ?? '') || row.id });
          }
        }
        if (rows.length < 200) break;
      }
      return { title: collection.name, options };
    }
    const type = readable(c, targetId);
    if (!type) return null;
    for (let offset = 0; offset < PICKER_CAP; offset += 1000) {
      const rows = await apiOf(c).list(type.id, { limit: 1000, offset });
      for (const e of rows) if (e.id !== selfId) options.push({ id: e.id, label: label(type, e) });
      if (rows.length < 1000) break;
    }
    return { title: type.name, options };
  }

  interface ActionSite {
    action: AdminAction<H>;
    id: string;
    /** The page of the thing acted on, and the list it belongs to. */
    entryUrl: string;
    listUrl: string;
    crumbs: { label: string; href?: string }[];
    name: string;
    exists(): Promise<boolean>;
  }

  async function confirmAction(c: Ctx, site: ActionSite) {
    const { action } = site;
    const target = action.target ? await targetOptions(c, action.target, site.id) : undefined;
    if (action.target && !target) return notFound(c);
    return c.html(
      confirmPage(shell, {
        title: `${action.label.replace(/…$/, '')}: ${site.name}`,
        question: action.confirm,
        action: `${site.entryUrl}/do/${action.id}`,
        confirmLabel: action.label.replace(/…$/, ''),
        destructive: !!action.destructive,
        cancel: site.entryUrl,
        target: target ? { label: target.title, options: target.options } : undefined,
        crumbs: site.crumbs
      })
    );
  }

  async function runAction(c: Ctx, site: ActionSite) {
    const { action } = site;
    const form = await c.req.formData();
    let chosen: string | undefined;
    if (action.target) {
      const picked = form.get('target');
      const options = await targetOptions(c, action.target, site.id);
      if (typeof picked !== 'string' || !options?.options.some(o => o.id === picked)) {
        return c.html(messagePage(shell, 'Nothing was done', 'Choose one of the entries offered.', { label: 'Back', href: site.entryUrl }), 422);
      }
      chosen = picked;
    }
    try {
      await action.run({ c, principal: principalOf(c), id: site.id, target: chosen });
    } catch (error) {
      const code = status(error, 500);
      if (code === 500) console.error(error);
      const message = error instanceof Error && error.message ? error.message : 'The action failed.';
      return c.html(messagePage(shell, `${action.label.replace(/…$/, '')} failed`, message, { label: 'Back', href: site.entryUrl }), code as 400);
    }
    // An action that removed what it was pressed on (a delete) returns to the list.
    const still = await site.exists();
    return c.redirect(`${still ? site.entryUrl : site.listUrl}?notice=${still ? 'done' : 'deleted'}`, 303);
  }

  async function storeSite(c: Ctx): Promise<ActionSite | null> {
    const { type, entry } = await entryOf(c);
    if (!type || !entry) return null;
    const action = (typeActions[type.id] ?? []).find(a => a.id === c.req.param('action'));
    if (!action || (action.requires && !can(rulesOf(c), type.id, action.requires, ruleRow(type, entry)))) return null;
    const name = label(type, entry);
    return {
      action,
      id: entry.id,
      name,
      entryUrl: `${mount}/t/${type.id}/${encodeURIComponent(entry.id)}`,
      listUrl: `${mount}/t/${type.id}`,
      crumbs: [{ label: type.name, href: `${mount}/t/${type.id}` }, { label: name }],
      exists: async () => (await apiOf(c).get(type.id, entry.id)) !== null
    };
  }

  async function externalSite(c: Ctx): Promise<ActionSite | null> {
    const collection = external(c, c.req.param('collection') ?? '');
    if (!collection) return null;
    const row = await collection.get(c, c.req.param('id') ?? '');
    const action = (collection.actions ?? []).find(a => a.id === c.req.param('action'));
    if (!row || !action) return null;
    const name = String(row[collection.displayField] ?? '') || row.id;
    return {
      action,
      id: row.id,
      name,
      entryUrl: `${mount}/x/${collection.id}/${encodeURIComponent(row.id)}`,
      listUrl: `${mount}/x/${collection.id}`,
      crumbs: [{ label: collection.name, href: `${mount}/x/${collection.id}` }, { label: name }],
      exists: async () => (await collection.get(c, row.id)) !== null
    };
  }

  app.get('/t/:type/:id/do/:action', async c => {
    const site = await storeSite(c);
    return site ? confirmAction(c, site) : notFound(c);
  });
  app.post('/t/:type/:id/do/:action', async c => {
    const site = await storeSite(c);
    return site ? runAction(c, site) : notFound(c);
  });

  // ── External collections ──────────────────────────────────────────

  app.get('/x/:collection', async c => {
    const collection = external(c, c.req.param('collection'));
    if (!collection) return notFound(c);
    const offset = Math.max(Math.trunc(Number(c.req.query('offset') ?? 0)) || 0, 0);
    const rows = await collection.list(c, { limit: PAGE + 1, offset });
    return c.html(externalListPage(shell, collection, rows.slice(0, PAGE), offset, PAGE, rows.length > PAGE));
  });

  app.get('/x/:collection/:id', async c => {
    const collection = external(c, c.req.param('collection'));
    const row: ExternalRow | null | undefined = await collection?.get(c, c.req.param('id'));
    if (!collection || !row) return notFound(c);
    const refs = await resolver(c, Object.fromEntries(Object.entries(collection.fields).map(([n, b]) => [n, b.meta])), row);
    return c.html(externalRowPage(shell, collection, row, refs, collection.actions ?? [], notice(c)));
  });

  app.get('/x/:collection/:id/do/:action', async c => {
    const site = await externalSite(c);
    return site ? confirmAction(c, site) : notFound(c);
  });
  app.post('/x/:collection/:id/do/:action', async c => {
    const site = await externalSite(c);
    return site ? runAction(c, site) : notFound(c);
  });

  // An external collection is a view: no create, save, publish or delete reaches it, whatever the method or path.
  app.all('/x/*', c =>
    c.req.method === 'GET' || c.req.method === 'HEAD'
      ? notFound(c)
      : c.html(messagePage(shell, 'Not allowed', 'This is a read-only view; it has no create, save or publish.'), 405, { allow: 'GET, HEAD' })
  );

  app.all('*', c => notFound(c));
  return app;
}

/** Mounts the admin on a host app: `mountAdmin(app, '/admin2', options)`. */
export function mountAdmin<H extends HostPrincipal = never>(host: Hono<any>, path: string, options: Omit<AdminOptions<H>, 'mount'>): void {
  host.route(path, createAdmin({ ...options, mount: path }));
}
