/**
 * The field renderers: nine kinds, each with a form to edit in and a read-only
 * form. A field the caller may not write is drawn with its read form, as text.
 * Every value reaches the page through `hono/html`'s template, which escapes it;
 * markdown is shown in a text area or a `pre`, never as markup.
 */
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { FieldMeta, FieldType } from '../core/index.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** The nine renderers. */
export type Kind = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'reference' | 'markdown' | 'files' | 'json';

export const KIND: Record<FieldType, Kind> = {
  text: 'text',
  longText: 'text',
  url: 'text',
  email: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  reference: 'reference',
  references: 'reference',
  markdown: 'markdown',
  files: 'files',
  json: 'json'
};

/** What a reference field links to: where the entry it names is shown, and a name for it. */
export interface RefTarget {
  href: string | null;
  label: string;
}
export type ResolveRef = (type: string, id: string) => RefTarget;

export interface RenderInput {
  name: string;
  meta: FieldMeta;
  value: unknown;
  refs: ResolveRef;
}

export interface Renderer {
  edit(input: RenderInput): Html;
  read(input: RenderInput): Html;
}

const MUTED = html`<span data-tone="secondary" data-variant="ghost">—</span>`;
/** HTML drops one newline right after a textarea's or pre's start tag, so each is written with one, and a value that begins with a newline keeps it. */
const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const asText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const idOf = (name: string) => `f-${name}`;

/** A link target is shown as a link only when it cannot run script. */
const safeHref = (value: string) => /^(https?:\/\/|\/(?!\/))/i.test(value);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const text: Renderer = {
  edit({ name, meta, value }) {
    if (meta.fieldType === 'longText') {
      return html`<textarea id="${idOf(name)}" name="${name}" rows="6">
${asText(value)}</textarea>`;
    }
    const type = meta.fieldType === 'url' ? 'url' : meta.fieldType === 'email' ? 'email' : 'text';
    return html`<input id="${idOf(name)}" type="${type}" name="${name}" value="${asText(value)}">`;
  },
  read({ meta, value }) {
    if (!present(value)) return MUTED;
    const s = asText(value);
    if (meta.fieldType === 'url' && safeHref(s)) return html`<a href="${s}">${s}</a>`;
    return html`<span>${s}</span>`;
  }
};

const number: Renderer = {
  edit: ({ name, value }) => html`<input id="${idOf(name)}" type="number" step="any" name="${name}" value="${asText(value)}">`,
  read: ({ value }) => (present(value) ? html`<span>${asText(value)}</span>` : MUTED)
};

const boolean: Renderer = {
  // A select, not a checkbox: an unchecked box sends nothing, which a save could not tell from a field that is not on the form.
  edit: ({ name, meta, value }) => html`<select id="${idOf(name)}" name="${name}">${
    meta.required ? '' : html`<option value=""${value === undefined || value === null ? ' selected' : ''}>—</option>`
  }<option value="true"${value === true ? ' selected' : ''}>Yes</option><option value="false"${value === false ? ' selected' : ''}>No</option></select>`,
  read: ({ value }) => (value === true ? html`<span>Yes</span>` : value === false ? html`<span>No</span>` : MUTED)
};

const date: Renderer = {
  edit: ({ name, value }) =>
    html`<input id="${idOf(name)}" type="text" name="${name}" value="${asText(value)}" placeholder="2026-11-14T09:30:00Z" autocomplete="off">`,
  read: ({ value }) => (present(value) ? html`<time datetime="${asText(value)}">${asText(value)}</time>` : MUTED)
};

const select: Renderer = {
  edit: ({ name, meta, value }) => html`<select id="${idOf(name)}" name="${name}">${
    meta.required && present(value) ? '' : html`<option value="">—</option>`
  }${(meta.options ?? []).map(option => html`<option value="${option}"${value === option ? ' selected' : ''}>${option}</option>`)}</select>`,
  read: ({ value }) => (present(value) ? html`<span>${asText(value)}</span>` : MUTED)
};

function refLink(meta: FieldMeta, id: string, refs: ResolveRef): Html {
  const target = refs(meta.refContentType ?? '', id);
  return target.href ? html`<a href="${target.href}">${target.label}</a>` : html`<span>${target.label}</span>`;
}

const reference: Renderer = {
  edit({ name, meta, value }) {
    if (meta.fieldType === 'references') {
      const ids = Array.isArray(value) ? value.map(asText).join('\n') : '';
      return html`<textarea id="${idOf(name)}" name="${name}" rows="3" placeholder="One id per line">
${ids}</textarea>`;
    }
    return html`<input id="${idOf(name)}" type="text" name="${name}" value="${asText(value)}">`;
  },
  read({ meta, value, refs }) {
    if (meta.fieldType === 'references') {
      const ids = Array.isArray(value) ? value.map(asText) : [];
      if (ids.length === 0) return MUTED;
      return html`<ul class="stack">${ids.map(id => html`<li>${refLink(meta, id, refs)}</li>`)}</ul>`;
    }
    return present(value) ? refLink(meta, asText(value), refs) : MUTED;
  }
};

const markdown: Renderer = {
  // The editor, when it loads, takes the place of this text area and writes back to it; without it this is the field.
  edit: ({ name, value }) => html`<textarea id="${idOf(name)}" name="${name}" rows="14" data-markdown>
${asText(value)}</textarea>`,
  read: ({ value }) => (present(value) ? html`<pre>
${asText(value)}</pre>` : MUTED)
};

const files: Renderer = {
  edit: input => files.read(input),
  read({ value }) {
    const list = Array.isArray(value) ? (value as { name?: unknown; size?: unknown; url?: unknown }[]) : [];
    if (list.length === 0) return html`<span data-tone="secondary" data-variant="ghost">No files stored.</span>`;
    return html`<ul class="stack">${list.map(file => {
      const name = asText(file.name);
      const url = asText(file.url);
      const size = typeof file.size === 'number' ? html` <small>${formatBytes(file.size)}</small>` : '';
      return safeHref(url) ? html`<li><a href="${url}" download="${name}">${name}</a>${size}</li>` : html`<li>${name}${size}</li>`;
    })}</ul>`;
  }
};

const pretty = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const json: Renderer = {
  edit: ({ name, value }) =>
    html`<textarea id="${idOf(name)}" name="${name}" rows="8" spellcheck="false">
${present(value) ? pretty(value) : ''}</textarea>`,
  read: ({ value }) => (present(value) ? html`<pre><code>
${pretty(value)}</code></pre>` : MUTED)
};

export const RENDERERS: Record<Kind, Renderer> = { text, number, boolean, date, select, reference, markdown, files, json };

export function renderField(input: RenderInput, mode: 'edit' | 'read'): Html {
  const renderer = RENDERERS[KIND[input.meta.fieldType]];
  return mode === 'edit' && input.meta.fieldType !== 'files' ? renderer.edit(input) : renderer.read(input);
}
