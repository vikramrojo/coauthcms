/** What a host gives the admin, and what it may add: external collections and actions. */
import type { Context } from 'hono';
import type { Cms, FieldBuilder, HostPrincipal, Operation, Principal } from '../core/index.ts';

/** What an action's `run` is told. */
export interface ActionContext<H extends HostPrincipal = never> {
  /** The request, for the host's bindings (`c.env`). */
  c: Context;
  principal: Principal<H>;
  /** The entry or row the action was pressed on. */
  id: string;
  /** The entry chosen when the action has a `target`. */
  target?: string;
}

/**
 * A button on an entry or row. Pressing it opens a page that shows `confirm`
 * (and a picker when there is a `target`), and `run` is called only when that
 * page is confirmed. A thrown error is shown on a page; a thrown error with a
 * numeric `status` answers with that status.
 */
export interface AdminAction<H extends HostPrincipal = never> {
  id: string;
  label: string;
  /** The question the confirmation page asks. */
  confirm: string;
  destructive?: boolean;
  /** A store type or external collection to pick an entry of first; its id arrives as `ActionContext.target`. */
  target?: string;
  /** Store types only: the operation the caller must hold on the entry for the button to be offered and the action to run. */
  requires?: Operation;
  run(context: ActionContext<H>): Promise<void>;
}

export interface ExternalRow {
  id: string;
  /** `published` shows the row as live, anything else as not; absent shows no state. */
  status?: string;
  [field: string]: unknown;
}

/** A read-only view over a table of the host's own. It is never stored as entries and has no create, save or publish. */
export interface ExternalCollection<H extends HostPrincipal = never> {
  id: string;
  name: string;
  /** The field shown as the row's title. */
  displayField: string;
  /** Its fields, built with `field.*` from core; `ref` and `refs` name a store type or another external collection. */
  fields: Record<string, FieldBuilder<any, any>>;
  list(c: Context, page: { limit: number; offset: number }): Promise<ExternalRow[]>;
  get(c: Context, id: string): Promise<ExternalRow | null>;
  actions?: AdminAction<H>[];
  /** Who may see it: only the admin kind when absent. */
  allow?(principal: Principal<H>): boolean;
  /** Whether a row is offered when this collection is an action's target; every row but the one acted on when absent. */
  pickable?(row: ExternalRow): boolean;
}

/** Where the admin's pages find the host's static files. Each is a URL the host serves. */
export interface AdminAssets {
  largen: string;
  largenDark: string;
  /** The markdown editor module (`scripts/build-admin-editor.ts` builds it to `admin-editor.js`). */
  editor: string;
  editorStyles: string;
  editorStylesDark: string;
}

/**
 * The host's sign-in, for a host whose credential is a cookie. Each function does the host's own work and answers its
 * own Response: a 2xx is success and its `set-cookie` headers are passed on, 401 is a wrong password, 429 too many
 * tries, anything else a failure. Given this, the admin draws a sign-in page for a caller who is not signed in
 * (instead of answering `unauthorized`), handles its three forms, and shows Sign out and Sign out everywhere.
 */
export interface AdminSession {
  signIn(c: Context, password: string): Promise<Response>;
  signOut(c: Context): Promise<Response>;
  signOutEverywhere(c: Context): Promise<Response>;
}

export interface AdminOptions<H extends HostPrincipal = never> {
  cms: Cms<H>;
  /** Who is calling, from the host's own credential; null for nobody, which answers `unauthorized` (401 by default). */
  resolvePrincipal(c: Context): Principal<H> | null | Promise<Principal<H> | null>;
  externalCollections?: ExternalCollection<H>[];
  /**
   * Actions on a store type's entries, by type id. One with the id `unpublish` or `delete` takes the place of the
   * page's own Unpublish or Delete, for a type whose host does more than the store does.
   */
  typeActions?: Record<string, AdminAction<H>[]>;
  /** The path the host mounts the admin at, with no trailing slash; every link starts with it. */
  mount: string;
  siteName?: string;
  assets?: Partial<AdminAssets>;
  /** The host's sign-in; when given, a caller who is not signed in gets the sign-in page (401) and signed-in pages carry the sign-out forms. */
  session?: AdminSession;
  /** What to answer when `resolvePrincipal` gives null and there is no `session`. */
  unauthorized?(c: Context): Response | Promise<Response>;
}
