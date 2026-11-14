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
import { directiveSupport } from './directives.js';

/** Puts an editor in `root` holding `markdown`; resolves to an object whose getMarkdown() is the text now. */
export async function createEditor(root, markdown) {
  const builder = new CrepeBuilder({ root, defaultValue: markdown })
    .addFeature(blockEdit)
    .addFeature(cursor)
    .addFeature(linkTooltip)
    .addFeature(listItem)
    .addFeature(toolbar);
  // A notebook's text (`:bar[9]`, `:staff[2]`, `::excerpt{...}`) opens as chips and saves as the same directives.
  directiveSupport(builder.editor);
  await builder.create();
  return { getMarkdown: () => builder.getMarkdown() };
}
