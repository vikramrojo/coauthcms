// The three directives of a notebook's text as Milkdown nodes: `:bar[9]` a bar link, `:staff[2]` a
// staff to listen for, and `::excerpt{from=5 to=8 view=part:1}` an embedded excerpt. Written for the composer's editor
// (page/editorTextEntry.js) and the admin's markdown editor (entry.js), so a note's text reads the same in both and the
// admin never mangles it: remark-directive parses the syntax, each directive is a small node that draws as a chip and
// serialises back to the same directive, and anything else the parser takes for a directive (a bare `:name` in prose, a
// container) is turned back into the text it was, so nothing the editor does not know makes it fail to open.
//
//   directiveSupport(builder.editor)         before create(): the remark plugins and the three nodes
//   insertBar(editor, 9) / insertStaff(editor, 2) / insertExcerpt(editor, { from, to, view })   at the selection
import { editorViewCtx, remarkPluginsCtx } from '@milkdown/kit/core';
import { $node } from '@milkdown/kit/utils';
import remarkDirective from 'remark-directive';

const labelOf = (node) => (node.children || []).map((child) => (typeof child.value === 'string' ? child.value : '')).join('');
const WHOLE = /^[1-9]\d{0,5}$/;
const viewOk = (view) => view === 'score' || /^part:[1-9]\d{0,2}$/.test(view);

/** How a view reads in a chip: "full score" or "part 2". */
export const viewWords = (view) => (view === 'score' ? 'full score' : view.replace('part:', 'part '));
const barsText = (from, to) => (from === to ? `bar ${from}` : `bars ${from} to ${to}`);

/** Does this node stay a directive? A bar or staff link with one whole number, an excerpt with its own three attributes. */
function keeps(node) {
  const a = node.attributes || {};
  if (node.type === 'textDirective') {
    return (node.name === 'bar' || node.name === 'staff') && WHOLE.test(labelOf(node)) && Object.keys(a).length === 0;
  }
  if (node.type === 'leafDirective') {
    return node.name === 'excerpt' && WHOLE.test(a.from || '') && WHOLE.test(a.to || '') && Number(a.to) >= Number(a.from)
      && (a.view === undefined || a.view === null || viewOk(a.view)) && (node.children || []).length === 0;
  }
  return false;
}

/** After remark-directive: every directive that is not one of the three (or is badly formed) goes back to the text it was. */
function normaliseDirectives() {
  return (tree, file) => {
    const source = String(file && file.value !== undefined ? file.value : '');
    const asText = (node) => {
      const start = node.position && node.position.start.offset;
      const end = node.position && node.position.end.offset;
      return typeof start === 'number' && typeof end === 'number' ? source.slice(start, end) : `:${node.name}`;
    };
    const walk = (parent) => {
      if (!parent.children) return;
      parent.children = parent.children.map((node) => {
        if (node.type === 'textDirective' && !keeps(node)) return { type: 'text', value: asText(node) };
        if ((node.type === 'leafDirective' && !keeps(node)) || node.type === 'containerDirective') {
          return { type: 'paragraph', children: [{ type: 'text', value: asText(node) }] };
        }
        walk(node);
        return node;
      });
    };
    walk(tree);
  };
}

const chipAttrs = (kind, label, extra = {}) => ({ class: `directive-chip ${kind}-chip`, 'data-directive': kind, contenteditable: 'false', title: label, ...extra });

const textLink = (id, name, words) =>
  $node(id, () => ({
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    attrs: { n: { default: 1 } },
    parseDOM: [{ tag: `span[data-directive="${name}"]`, getAttrs: (dom) => ({ n: Number(dom.getAttribute('data-n')) || 1 }) }],
    toDOM: (node) => ['span', chipAttrs(name, `${words} ${node.attrs.n}`, { 'data-n': String(node.attrs.n) }), `${words} ${node.attrs.n}`],
    parseMarkdown: {
      match: (node) => node.type === 'textDirective' && node.name === name,
      runner: (state, node, type) => { state.addNode(type, { n: Number(labelOf(node)) }); }
    },
    toMarkdown: {
      match: (node) => node.type.name === id,
      runner: (state, node) => { state.addNode('textDirective', [{ type: 'text', value: String(node.attrs.n) }], undefined, { name, attributes: {} }); }
    }
  }));

export const barLink = textLink('bar_link', 'bar', 'bar');
export const staffLink = textLink('staff_link', 'staff', 'listen for staff');

export const excerpt = $node('excerpt', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { from: { default: 1 }, to: { default: 1 }, view: { default: 'score' } },
  parseDOM: [{
    tag: 'div[data-directive="excerpt"]',
    getAttrs: (dom) => ({ from: Number(dom.getAttribute('data-from')) || 1, to: Number(dom.getAttribute('data-to')) || 1, view: dom.getAttribute('data-view') || 'score' })
  }],
  toDOM: (node) => {
    const { from, to, view } = node.attrs;
    const words = `Excerpt: ${barsText(from, to)}, ${viewWords(view)}`;
    return ['div', chipAttrs('excerpt', words, { 'data-from': String(from), 'data-to': String(to), 'data-view': view }), words];
  },
  parseMarkdown: {
    match: (node) => node.type === 'leafDirective' && node.name === 'excerpt',
    runner: (state, node, type) => {
      const a = node.attributes || {};
      state.addNode(type, { from: Number(a.from), to: Number(a.to), view: a.view || 'score' });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'excerpt',
    runner: (state, node) => {
      const { from, to, view } = node.attrs;
      state.addNode('leafDirective', undefined, undefined, { name: 'excerpt', attributes: { from: String(from), to: String(to), view } });
    }
  }
}));

/** Adds remark-directive, the clean-up after it and the three nodes to a Milkdown editor that is not yet created. */
export function directiveSupport(editor) {
  editor
    .config((ctx) => {
      ctx.update(remarkPluginsCtx, (plugins) => [...plugins, { plugin: remarkDirective, options: {} }, { plugin: normaliseDirectives, options: {} }]);
    })
    .use(barLink)
    .use(staffLink)
    .use(excerpt);
  return editor;
}

function insert(editor, typeName, attrs) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const type = view.state.schema.nodes[typeName];
    if (!type) return;
    view.dispatch(view.state.tr.replaceSelectionWith(type.create(attrs)).scrollIntoView());
    view.focus();
  });
}

export const insertBar = (editor, n) => insert(editor, 'bar_link', { n });
export const insertStaff = (editor, n) => insert(editor, 'staff_link', { n });
export const insertExcerpt = (editor, { from, to, view }) => insert(editor, 'excerpt', { from, to, view });
