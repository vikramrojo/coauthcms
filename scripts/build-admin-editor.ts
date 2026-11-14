/**
 * Builds the admin's markdown editor (Milkdown Crepe, as one static module) and
 * writes it where the host serves its static files:
 *
 *   bun run node_modules/cogens/scripts/build-admin-editor.ts <outDir> [--plugins <module>]
 *
 * writes <outDir>/admin-editor.js, admin-editor.css, admin-editor-dark.css and
 * admin-editor.LICENSES.txt (the licence texts of every package in the bundle,
 * which the module's banner names). Those are the names `createAdmin` links by
 * default (`DEFAULT_ASSETS`), at the root of the host's static folder; serve
 * them elsewhere and pass `assets` to `createAdmin`.
 *
 * `--plugins <module>` names a host file whose default export is a function
 * `(builder, context) => void | Promise<void>`. The bundle calls it with the
 * Crepe builder (`builder.editor` is the Milkdown editor) and `context = { type, field }`
 * (the content type id and field name of the text area) before the editor is
 * created, and the path resolves from the current working directory, so the host can add remark plugins, nodes and node views. The
 * module imports its own Milkdown packages from the host's node_modules.
 * Without it the editor has no syntax of the host's.
 *
 * The build needs `@milkdown/crepe`, an optional peer dependency of cogens:
 * add it to the host (`bun add -d @milkdown/crepe`). Nothing in the Worker
 * imports the editor or Crepe.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const HERE = join(import.meta.dir, '..', 'editor');

/** The package folder an input path belongs to: the part up to the last `node_modules/<name>` (or `<@scope/name>`). */
function packageRoot(input: string): string | null {
  const marker = 'node_modules/';
  const at = input.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = input.slice(at + marker.length).split('/');
  const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
  return input.slice(0, at + marker.length) + name;
}

const PLUGIN_MODULE = 'cogens-editor-plugin';

/** Resolves the entry's `cogens-editor-plugin` import to the host's module, or to an empty one. */
function pluginResolver(plugin: string | null): Bun.BunPlugin {
  return {
    name: 'cogens-editor-plugin',
    setup(build) {
      build.onResolve({ filter: /^cogens-editor-plugin$/ }, () =>
        plugin ? { path: plugin } : { path: PLUGIN_MODULE, namespace: 'cogens-empty' });
      build.onLoad({ filter: /.*/, namespace: 'cogens-empty' }, () => ({ contents: 'export default undefined;', loader: 'js' }));
    }
  };
}

type Notice = { name: string; version: string; license: string; text: string };

async function notices(entries: string[], out: string, plugin: string | null): Promise<void> {
  const roots = new Set<string>();
  for (const entry of entries) {
    const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true, metafile: true, plugins: [pluginResolver(plugin)] });
    if (!result.success || !result.metafile) throw new Error(`Could not bundle ${entry}: ${result.logs.join('\n')}`);
    for (const input of Object.keys(result.metafile.inputs)) {
      const root = packageRoot(isAbsolute(input) ? input : resolve(process.cwd(), input));
      if (root) roots.add(root);
    }
  }
  const list: Notice[] = [];
  for (const dir of roots) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
    if (pkg.name === 'cogens') continue; // this package's own editor files, under the host's node_modules
    const file = readdirSync(dir).find(f => /^(licen[sc]e|copying)(\.|$)/i.test(f));
    if (!file) throw new Error(`${pkg.name} ${pkg.version} has no licence file in ${dir}; add its text here by hand before shipping.`);
    list.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'see text', text: readFileSync(join(dir, file), 'utf8').trim() });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  const header = [
    'Third-party notices for admin-editor.js, admin-editor.css and admin-editor-dark.css',
    "(cogens's admin markdown editor, Milkdown Crepe and the packages it bundles).",
    `${list.length} packages. Written by scripts/build-admin-editor.ts; do not edit by hand.`,
    'DOMPurify is dual-licensed MPL-2.0 or Apache-2.0 and is used here under Apache-2.0.'
  ].join('\n');
  const body = list.map(n => `${'='.repeat(78)}\n${n.name} ${n.version} (${n.license})\n${'='.repeat(78)}\n\n${n.text}\n`).join('\n');
  writeFileSync(out, `${header}\n\n${body}`);
  console.log(`${out}: ${list.length} packages`);
}

async function build(entry: string, outDir: string, name: string, options: Record<string, unknown>): Promise<void> {
  const result = await Bun.build({ entrypoints: [entry], outdir: outDir, naming: name, minify: true, ...options });
  if (!result.success) throw new Error(`Could not build ${name}:\n${result.logs.join('\n')}`);
}

/**
 * The folder of `@milkdown/crepe` as the host installed it. Its style sheets are not in the package's `exports`, so a
 * bare `@import` cannot name them; editor.css and editor-dark.css write `%CREPE%` and this puts the real folder there.
 */
function crepeFolder(): string {
  let dir = dirname(Bun.resolveSync('@milkdown/crepe', HERE));
  while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== '@milkdown/crepe') {
    const up = dirname(dir);
    if (up === dir) throw new Error('@milkdown/crepe is not installed. Add it: bun add -d @milkdown/crepe');
    dir = up;
  }
  return dir;
}

/** A copy of one of the editor's style sheets with `%CREPE%` filled in, in a folder the caller removes. */
function stylesheet(name: string, scratch: string): string {
  const out = join(scratch, name);
  writeFileSync(out, readFileSync(join(HERE, name), 'utf8').replaceAll('%CREPE%', crepeFolder()));
  return out;
}

const args = process.argv.slice(2);
const flag = args.indexOf('--plugins');
let pluginArg: string | null = null;
if (flag >= 0) {
  pluginArg = args[flag + 1] ?? null;
  if (!pluginArg) {
    console.error('--plugins needs a module path.');
    process.exit(1);
  }
  args.splice(flag, 2);
}
const outArg = args[0];
if (!outArg) {
  console.error('Usage: bun run scripts/build-admin-editor.ts <outDir> [--plugins <module>]');
  process.exit(1);
}
const plugin = pluginArg ? resolve(process.cwd(), pluginArg) : null;
if (plugin && !existsSync(plugin)) {
  console.error(`Plugin module not found: ${plugin}`);
  process.exit(1);
}
const out = resolve(process.cwd(), outArg);
mkdirSync(out, { recursive: true });

await build(join(HERE, 'entry.js'), out, 'admin-editor.js', {
  format: 'esm',
  target: 'browser',
  banner: '/*! Third-party notices: /admin-editor.LICENSES.txt */',
  plugins: [pluginResolver(plugin)]
});
const scratch = mkdtempSync(join(tmpdir(), 'cogens-editor-'));
try {
  const light = stylesheet('editor.css', scratch);
  const dark = stylesheet('editor-dark.css', scratch);
  await build(light, out, 'admin-editor.css', {});
  await build(dark, out, 'admin-editor-dark.css', {});
  await notices([join(HERE, 'entry.js'), light, dark], join(out, 'admin-editor.LICENSES.txt'), plugin);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
for (const f of ['admin-editor.js', 'admin-editor.css', 'admin-editor-dark.css', 'admin-editor.LICENSES.txt']) {
  if (!existsSync(join(out, f))) throw new Error(`${f} was not written.`);
}
