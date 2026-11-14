/**
 * coauthcms/admin: the server-rendered admin pages.
 * May import `coauthcms` core and `hono`, nothing else of ours.
 *
 *   app.route('/admin', createAdmin({ cms, resolvePrincipal, mount: '/admin' }));
 *
 * The pages are Hono routes rendered with `hono/html` and styled by Largen. The
 * markdown editor is a static file the host serves (`scripts/build-admin-editor.ts` builds it).
 */
export { createAdmin, mountAdmin, DEFAULT_ASSETS } from './app.ts';
export { ADMIN_CSS, ADMIN_JS } from './assets.ts';
export { KIND, RENDERERS, renderField } from './fields.ts';
export type { Html, Kind, RefTarget, RenderInput, Renderer, ResolveRef } from './fields.ts';
export type {
  ActionContext, AdminAction, AdminAssets, AdminSession, AdminOptions, ExternalCollection, ExternalRow
} from './types.ts';
