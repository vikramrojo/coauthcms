// The markdown editor of the content admin: Milkdown's Crepe with the features a text
// field needs, built by scripts/build-admin-editor.ts. The admin's own script (src/admin/assets.ts)
// loads this module on a page that has a markdown field and calls createEditor on each text area. Nothing in the Worker
// imports this file or @milkdown/crepe.
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
// Resolved by scripts/build-admin-editor.ts: the host's plugin module given by --plugins, else a module with no default.
import plugin from 'coauthcms-editor-plugin';

/** Puts an editor in `root` holding `markdown`; resolves to an object whose getMarkdown() is the text now. */
export async function createEditor(root, markdown) {
  const builder = new CrepeBuilder({ root, defaultValue: markdown })
    .addFeature(blockEdit)
    .addFeature(cursor)
    .addFeature(linkTooltip)
    .addFeature(listItem)
    .addFeature(toolbar);
  // The host's own syntax, if it gave a plugin module: called with the builder before it is created.
  if (typeof plugin === 'function') await plugin(builder);
  await builder.create();
  return { getMarkdown: () => builder.getMarkdown(), editor: builder.editor };
}
