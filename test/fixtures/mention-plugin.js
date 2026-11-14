// A host's editor plugin: `:mention[ada]` opens as a chip and saves as the same text.
import { remarkPluginsCtx } from '@milkdown/kit/core';
import { $node } from '@milkdown/kit/utils';
import remarkDirective from 'remark-directive';

const labelOf = node => (node.children || []).map(c => (typeof c.value === 'string' ? c.value : '')).join('');

// Any other `:word` in prose goes back to the text it was.
function keepOnlyMentions() {
  return (tree, file) => {
    const source = String(file?.value ?? '');
    const walk = parent => {
      if (!parent.children) return;
      parent.children = parent.children.map(node => {
        if (node.type === 'leafDirective' || node.type === 'containerDirective' || (node.type === 'textDirective' && node.name !== 'mention')) {
          const { start, end } = node.position ?? {};
          return { type: 'text', value: source.slice(start?.offset ?? 0, end?.offset ?? 0) };
        }
        walk(node);
        return node;
      });
    };
    walk(tree);
  };
}

const mention = $node('mention', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { name: { default: '' } },
  parseDOM: [{ tag: 'span[data-mention]', getAttrs: dom => ({ name: dom.getAttribute('data-mention') }) }],
  toDOM: node => ['span', { 'data-mention': node.attrs.name, contenteditable: 'false' }, `@${node.attrs.name}`],
  parseMarkdown: {
    match: node => node.type === 'textDirective' && node.name === 'mention',
    runner: (state, node, type) => { state.addNode(type, { name: labelOf(node) }); }
  },
  toMarkdown: {
    match: node => node.type.name === 'mention',
    runner: (state, node) => { state.addNode('textDirective', [{ type: 'text', value: node.attrs.name }], undefined, { name: 'mention', attributes: {} }); }
  }
}));

export default function (builder) {
  builder.editor
    .config(ctx => {
      ctx.update(remarkPluginsCtx, plugins => [...plugins, { plugin: remarkDirective, options: {} }, { plugin: keepOnlyMentions, options: {} }]);
    })
    .use(mention);
}
