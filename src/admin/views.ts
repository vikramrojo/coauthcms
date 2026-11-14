/**
 * The pages, as functions from plain data to HTML. Nothing here reads a request
 * or calls the store; the routes do that and pass what the page shows. Styling
 * is Largen's (elements, `data-tone`, `data-variant`, the layout utilities).
 */
import { html } from 'hono/html';
import type { ContentType, Entry, FieldMeta } from '../core/index.ts';
import { renderField, type Html, type ResolveRef } from './fields.ts';
import type { AdminAction, AdminAssets, ExternalCollection, ExternalRow } from './types.ts';

export interface Shell {
  mount: string;
  /** The admin's first page: the mount itself (a route mounted at a path answers there, with no trailing slash). */
  home: string;
  siteName: string;
  assets: AdminAssets;
  /** The host gave a sign-in: pages carry Sign out and Sign out everywhere. */
  session?: boolean;
}

const NOTICES: Record<string, string> = {
  saved: 'Saved.',
  created: 'Created.',
  published: 'Published.',
  unpublished: 'Unpublished.',
  deleted: 'Deleted.',
  done: 'Done.'
};
export const noticeText = (key: string | undefined) => (key === undefined ? undefined : NOTICES[key]);

export interface PageInput {
  title: string;
  body: Html;
  /** The page has a markdown field to edit: it links the editor's styles and names its module. */
  editor?: boolean;
  crumbs?: { label: string; href?: string }[];
  notice?: string;
  problems?: string[];
  /** A page for someone who is not signed in: no sign-out forms. */
  signedOut?: boolean;
}

export function page(shell: Shell, input: PageInput): Html {
  const { mount, assets } = shell;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${input.title} · ${shell.siteName}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${assets.largen}">
<link rel="stylesheet" href="${assets.largenDark}" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="${mount}/assets/admin.css">${
    input.editor
      ? html`
<link rel="stylesheet" href="${assets.editorStyles}">
<link rel="stylesheet" href="${assets.editorStylesDark}" media="(prefers-color-scheme: dark)">`
      : ''
  }
</head>
<body>
<main class="center stack">
<header class="stack">
<nav class="cluster" aria-label="Breadcrumb"><a href="${shell.home}">${shell.siteName}</a>${(input.crumbs ?? []).map(
    c => html`<span aria-hidden="true">/</span>${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span>${c.label}</span>`}`
  )}</nav>
<h1>${input.title}</h1>
</header>${input.notice ? html`
<p role="status" data-tone="success" data-variant="soft">${input.notice}</p>` : ''}${
    input.problems && input.problems.length > 0
      ? html`
<div role="alert" data-tone="danger" data-variant="soft"><p>Nothing was changed.</p><ul>${input.problems.map(p => html`<li>${p}</li>`)}</ul></div>`
      : ''
  }
${input.body}${shell.session && !input.signedOut ? html`
<footer class="cluster"><form method="post" action="${mount}/sign-out"><button type="submit" data-variant="ghost">Sign out</button></form><form method="post" action="${mount}/sign-out-everywhere"><button type="submit" data-variant="ghost">Sign out everywhere</button></form></footer>` : ''}
</main>
<script defer src="${mount}/assets/admin.js"${input.editor ? html` data-editor="${assets.editor}"` : ''}></script>
</body>
</html>`;
}

export function messagePage(shell: Shell, title: string, message: string, back?: { label: string; href: string }): Html {
  return page(shell, {
    title,
    body: html`<p>${message}</p>${back ? html`<p><a href="${back.href}">${back.label}</a></p>` : ''}`
  });
}

/** The sign-in page: a password form that posts to the admin and works with JavaScript off. */
export function signInPage(shell: Shell, next: string, error?: string): Html {
  return page(shell, {
    title: 'Sign in',
    signedOut: true,
    body: html`${error ? html`<p role="alert" data-tone="danger" data-variant="soft">${error}</p>` : ''}
<form method="post" action="${shell.mount}/sign-in" class="stack">
<input type="hidden" name="next" value="${next}">
<label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<p><button type="submit">Sign in</button></p>
</form>`
  });
}

// ── The type list ───────────────────────────────────────────────────

export function typeListPage(shell: Shell, stored: { id: string; name: string }[], external: { id: string; name: string }[]): Html {
  const { mount } = shell;
  const list = (items: { id: string; name: string }[], base: string) =>
    html`<ul class="stack">${items.map(t => html`<li><a href="${mount}/${base}/${t.id}">${t.name}</a></li>`)}</ul>`;
  return page(shell, {
    title: 'Content',
    body:
      stored.length === 0 && external.length === 0
        ? html`<p>There is nothing here you may read.</p>`
        : html`${stored.length > 0 ? html`<section class="stack"><h2>Types</h2>${list(stored, 't')}</section>` : ''}${
            external.length > 0 ? html`<section class="stack"><h2>Tables</h2>${list(external, 'x')}</section>` : ''
          }`
  });
}

// ── An entry list ───────────────────────────────────────────────────

export interface ListInput {
  type: ContentType<any>;
  entries: Entry[];
  q: string;
  status: string;
  owner: string;
  offset: number;
  limit: number;
  hasNext: boolean;
  canCreate: boolean;
  notice?: string;
}

function query(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== 0) search.set(k, String(v));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function entryListPage(shell: Shell, input: ListInput): Html {
  const { mount } = shell;
  const { type } = input;
  const base = `${mount}/t/${type.id}`;
  const title = (e: Entry) => String(e.data[type.displayField] ?? '') || e.slug || e.id;
  const filters = { q: input.q, status: input.status, owner: input.owner };
  return page(shell, {
    title: type.name,
    crumbs: [],
    notice: input.notice,
    body: html`
<form method="get" action="${base}" class="cluster" role="search">
<input type="search" name="q" value="${input.q}" placeholder="Slug" aria-label="Search by slug">
<select name="status" aria-label="Status" data-autosubmit><option value="">Any status</option><option value="published"${input.status === 'published' ? ' selected' : ''}>Published</option><option value="draft"${input.status === 'draft' ? ' selected' : ''}>Draft</option></select>${
      type.owned ? html`<input type="text" name="owner" value="${input.owner}" placeholder="Owner id" aria-label="Owner">` : ''
    }
<button type="submit" data-variant="outline">Filter</button>${
      input.q || input.status || input.owner ? html`<a href="${base}">Clear</a>` : ''
    }${input.canCreate ? html`<a href="${base}/new">New ${type.name.replace(/s$/, '')}</a>` : ''}
</form>${
      input.entries.length === 0
        ? html`<p>No entries.</p>`
        : html`
<table>
<thead><tr><th scope="col">${type.fieldMeta[type.displayField]?.label ?? 'Title'}</th><th scope="col">Slug</th><th scope="col">Status</th>${type.owned ? html`<th scope="col">Owner</th>` : ''}<th scope="col">Updated</th></tr></thead>
<tbody>${input.entries.map(
          e => html`<tr><td><a href="${base}/${e.id}">${title(e)}</a></td><td>${e.slug ?? ''}</td><td>${statusBadge(e.status)}</td>${type.owned ? html`<td>${e.owner_id ?? ''}</td>` : ''}<td>${e.updated_at}</td></tr>`
        )}</tbody>
</table>`
    }
<nav class="cluster" aria-label="Pages">${
      input.offset > 0 ? html`<a href="${base}${query({ ...filters, offset: Math.max(input.offset - input.limit, 0) })}">Previous</a>` : ''
    }${input.hasNext ? html`<a href="${base}${query({ ...filters, offset: input.offset + input.limit })}">Next</a>` : ''}</nav>`
  });
}

export function statusBadge(status: string | undefined): Html {
  if (status === undefined || status === '') return html``;
  const live = status === 'published';
  return html`<span data-tone="${live ? 'success' : 'secondary'}" data-variant="soft">${status}</span>`;
}

// ── One entry ───────────────────────────────────────────────────────

export interface Row {
  name: string;
  meta: FieldMeta;
  value: unknown;
  editable: boolean;
  error?: string;
}

export interface Column {
  label: string;
  name: string;
  value: string | null;
  editable: boolean;
}

/** The label and control (or text) of each row, as a definition list the form's layout styles. */
function fieldRows(rows: Row[], columns: Column[], refs: ResolveRef): Html {
  return html`<dl class="fields">${columns.map(col =>
    col.editable
      ? html`<dt><label for="f-${col.name}">${col.label}</label></dt><dd><input id="f-${col.name}" type="text" name="${col.name}" value="${col.value ?? ''}"></dd>`
      : html`<dt>${col.label}</dt><dd>${col.value === null || col.value === '' ? html`<span data-tone="secondary" data-variant="ghost">—</span>` : html`<span>${col.value}</span>`}</dd>`
  )}${rows.map(row => {
    const error = row.error ? html`<small data-tone="danger" data-variant="ghost">${row.name} ${row.error}</small>` : '';
    return row.editable
      ? html`<dt><label for="f-${row.name}">${row.meta.label}</label></dt><dd>${renderField({ name: row.name, meta: row.meta, value: row.value, refs }, 'edit')}${error}</dd>`
      : html`<dt>${row.meta.label}</dt><dd>${renderField({ name: row.name, meta: row.meta, value: row.value, refs }, 'read')}${error}</dd>`;
  })}</dl>`;
}

export interface EntryInput {
  type: ContentType<any>;
  /** Absent for a new entry. */
  entry?: Entry;
  columns: Column[];
  rows: Row[];
  refs: ResolveRef;
  /** The save button: some field may be written. */
  canSave: boolean;
  canPublish: boolean;
  canUnpublish: boolean;
  canDelete: boolean;
  actions: AdminAction<any>[];
  notice?: string;
  problems?: string[];
}

export function entryPage(shell: Shell, input: EntryInput): Html {
  const { mount } = shell;
  const { type, entry } = input;
  const base = `${mount}/t/${type.id}`;
  const title = entry ? String(entry.data[type.displayField] ?? '') || entry.slug || entry.id : `New ${type.name.replace(/s$/, '')}`;
  const action = entry ? `${base}/${entry.id}` : base;
  const fields = fieldRows(input.rows, input.columns, input.refs);
  const markdown = input.rows.some(r => r.editable && r.meta.fieldType === 'markdown');
  return page(shell, {
    title,
    editor: markdown,
    crumbs: [{ label: type.name, href: base }, { label: title }],
    notice: input.notice,
    problems: input.problems,
    body: html`${
      input.canSave
        ? html`<form method="post" action="${action}" class="stack">${fields}<div class="cluster"><button type="submit" data-tone="primary" data-variant="solid">${entry ? 'Save' : 'Create'}</button></div></form>`
        : fields
    }${
      entry
        ? html`<section class="cluster" aria-label="Actions">${
            entry.status === 'published'
              ? input.canUnpublish
                ? html`<form method="post" action="${base}/${entry.id}/unpublish"><button type="submit" data-variant="outline">Unpublish</button></form>`
                : ''
              : input.canPublish
                ? html`<form method="post" action="${base}/${entry.id}/publish"><button type="submit" data-tone="success" data-variant="solid">Publish</button></form>`
                : ''
          }${input.actions.map(
            a => html`<form method="get" action="${base}/${entry.id}/do/${a.id}"><button type="submit" data-tone="${a.destructive ? 'danger' : 'secondary'}" data-variant="${a.destructive ? 'outline' : 'solid'}">${a.label}</button></form>`
          )}${
            input.canDelete
              ? html`<form method="get" action="${base}/${entry.id}/delete"><button type="submit" data-tone="danger" data-variant="outline">Delete</button></form>`
              : ''
          }</section>`
        : ''
    }`
  });
}

// ── Confirmation ────────────────────────────────────────────────────

export interface ConfirmInput {
  title: string;
  question: string;
  action: string;
  confirmLabel: string;
  destructive: boolean;
  cancel: string;
  /** A picker for the action's target. */
  target?: { label: string; options: { id: string; label: string }[] };
  crumbs?: { label: string; href?: string }[];
}

export function confirmPage(shell: Shell, input: ConfirmInput): Html {
  return page(shell, {
    title: input.title,
    crumbs: input.crumbs,
    body: html`<form method="post" action="${input.action}" class="stack">
<p>${input.question}</p>${
      input.target
        ? html`<label class="stack">${input.target.label}<select name="target" required><option value="">Choose…</option>${input.target.options.map(
            o => html`<option value="${o.id}">${o.label}</option>`
          )}</select></label>`
        : ''
    }
<div class="cluster"><button type="submit" data-tone="${input.destructive ? 'danger' : 'primary'}" data-variant="solid">${input.confirmLabel}</button><a href="${input.cancel}">Cancel</a></div>
</form>`
  });
}

// ── External collections ────────────────────────────────────────────

export function externalListPage(
  shell: Shell,
  collection: ExternalCollection<any>,
  rows: ExternalRow[],
  offset: number,
  limit: number,
  hasNext: boolean
): Html {
  const base = `${shell.mount}/x/${collection.id}`;
  const label = (r: ExternalRow) => String(r[collection.displayField] ?? '') || r.id;
  return page(shell, {
    title: collection.name,
    body: html`${
      rows.length === 0
        ? html`<p>No rows.</p>`
        : html`<table><thead><tr><th scope="col">${collection.fields[collection.displayField]?.meta.label ?? 'Name'}</th><th scope="col">State</th></tr></thead><tbody>${rows.map(
            r => html`<tr><td><a href="${base}/${r.id}">${label(r)}</a></td><td>${statusBadge(typeof r.state === 'string' ? r.state : r.status)}</td></tr>`
          )}</tbody></table>`
    }<nav class="cluster" aria-label="Pages">${offset > 0 ? html`<a href="${base}${query({ offset: Math.max(offset - limit, 0) })}">Previous</a>` : ''}${
      hasNext ? html`<a href="${base}${query({ offset: offset + limit })}">Next</a>` : ''
    }</nav>`
  });
}

export function externalRowPage(
  shell: Shell,
  collection: ExternalCollection<any>,
  row: ExternalRow,
  refs: ResolveRef,
  actions: AdminAction<any>[],
  notice?: string
): Html {
  const base = `${shell.mount}/x/${collection.id}`;
  const title = String(row[collection.displayField] ?? '') || row.id;
  const rows: Row[] = Object.entries(collection.fields).map(([name, builder]) => ({
    name,
    meta: builder.meta,
    value: row[name],
    editable: false
  }));
  return page(shell, {
    title,
    notice,
    crumbs: [{ label: collection.name, href: base }, { label: title }],
    body: html`${fieldRows(rows, [], refs)}${
      actions.length > 0
        ? html`<section class="cluster" aria-label="Actions">${actions.map(
            a => html`<form method="get" action="${base}/${row.id}/do/${a.id}"><button type="submit" data-tone="${a.destructive ? 'danger' : 'secondary'}" data-variant="${a.destructive ? 'outline' : 'solid'}">${a.label}</button></form>`
          )}</section>`
        : ''
    }`
  });
}
