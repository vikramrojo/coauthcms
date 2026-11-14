/** A host for the admin's tests: the sample store plus two types for narrower callers, mounted at /admin2 in a Hono app. */
import { Hono } from 'hono';
import { contentType, field, type AccessContext, type Principal } from '../src/core/index.ts';
import { createAdmin, type AdminAction, type ExternalCollection } from '../src/admin/index.ts';
import { admin, anonymous, composer, createWorld, page, score, type Composer, type World } from './sample.ts';

export interface Staff {
  kind: 'staff';
}
export const staff: Staff = { kind: 'staff' };

/** The admin may do everything; staff may read it. */
export const memo = contentType({
  id: 'memo',
  name: 'Memos',
  displayField: 'title',
  uniqueSlug: true,
  fields: { title: field.text('Title').required(), body: field.markdown('Body') },
  access(principal: Principal<Composer | Staff>, { can }: AccessContext) {
    if (principal.kind === 'admin') can(['create', 'read', 'update', 'delete', 'publish']);
    if (principal.kind === 'staff') can('read');
  }
});

/** The admin may only read it. */
export const ledger = contentType({
  id: 'ledger',
  name: 'Ledger',
  displayField: 'title',
  fields: { title: field.text('Title').required(), amount: field.number('Amount') },
  access(principal: Principal<Composer | Staff>, { can }: AccessContext) {
    if (principal.kind === 'admin') can('read');
  }
});

export const ORIGIN = 'http://localhost';

export async function createAdminWorld(types: unknown[] = [score, page, memo, ledger]): Promise<World> {
  return createWorld(types as never, { probes: [composer('probe'), staff] as never });
}

export interface Mounted {
  host: Hono;
  /** A GET as the named principal (`admin`, `staff`, `composer:A`, `anon`; none is nobody). */
  get(path: string, as?: string | null, headers?: Record<string, string>): Promise<Response>;
  /** A form POST from the admin's own pages. */
  post(path: string, fields?: Record<string, string>, as?: string | null, headers?: Record<string, string>): Promise<Response>;
}

export function mount(
  w: World,
  options: { externalCollections?: ExternalCollection<any>[]; typeActions?: Record<string, AdminAction<any>[]>; env?: unknown } = {}
): Mounted {
  const resolvePrincipal = (c: { req: { header(name: string): string | undefined } }) => {
    const who = c.req.header('x-principal');
    if (!who) return null;
    if (who === 'admin') return admin('operator');
    if (who === 'staff') return staff;
    if (who === 'anon') return anonymous;
    if (who.startsWith('composer:')) return composer(...who.slice(9).split(','));
    return null;
  };
  const host = new Hono();
  host.route(
    '/admin2',
    createAdmin<any>({
      cms: w.cms as never,
      resolvePrincipal: resolvePrincipal as never,
      externalCollections: options.externalCollections,
      typeActions: options.typeActions,
      mount: '/admin2',
      siteName: 'Test'
    })
  );
  const env = options.env ?? {};
  const withWho = (as: string | null | undefined, extra: Record<string, string> = {}) => ({ ...(as ? { 'x-principal': as } : {}), ...extra });
  return {
    host,
    get: (path, as = 'admin', headers) => Promise.resolve(host.request(`${ORIGIN}/admin2${path === '/' ? '' : path}`, { headers: withWho(as, headers) }, env)),
    post: (path, fields = {}, as = 'admin', headers) =>
      Promise.resolve(
        host.request(
          `${ORIGIN}/admin2${path}`,
          {
            method: 'POST',
            headers: withWho(as, { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers }),
            body: new URLSearchParams(fields).toString()
          },
          env
        )
      )
  };
}

export { admin, anonymous, composer };
