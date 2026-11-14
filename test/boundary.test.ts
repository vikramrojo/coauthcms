/**
 * Tasks 1.1 and 1.2: the three folders under src/ import one way only, the
 * SQL layer is reached from nowhere but the store, and core has three runtime
 * dependencies and no more.
 *
 *   core   imports nothing of ours; hono, @casl/ability, @cfworker/json-schema only
 *   admin  imports core; hono only besides
 *   auth   imports neither; hono only besides
 *   src/core/store/sql.ts is imported by files inside src/core/store only
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { specifiers } from './imports.ts';

const ROOT = resolve(import.meta.dir, '..');
const PACKAGES = join(ROOT, 'src');
const SQL_LAYER = join(PACKAGES, 'core/store/sql.ts');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const bare = (specifier: string) => !specifier.startsWith('.') && !specifier.startsWith('/');
const fromHono = (s: string) => s === 'hono' || s.startsWith('hono/');
const CORE_PACKAGES = (s: string) => fromHono(s) || s === '@casl/ability' || s === '@casl/ability/extra' || s === '@cfworker/json-schema';
const HONO_ONLY = fromHono;

interface Rule {
  folder: string;
  /** The folders (absolute) a relative import may land in. */
  inside: string[];
  packages: (specifier: string) => boolean;
}

const RULES: Rule[] = [
  { folder: join(PACKAGES, 'core'), inside: [join(PACKAGES, 'core')], packages: CORE_PACKAGES },
  { folder: join(PACKAGES, 'admin'), inside: [join(PACKAGES, 'admin'), join(PACKAGES, 'core')], packages: HONO_ONLY },
  { folder: join(PACKAGES, 'auth'), inside: [join(PACKAGES, 'auth')], packages: HONO_ONLY }
];

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** The violations of the import boundary in one file, each saying which file and which import. */
export function violations(file: string, source: string): string[] {
  const rule = RULES.find(r => within(file, r.folder));
  const found: string[] = [];
  for (const specifier of specifiers(source)) {
    if (rule) {
      if (bare(specifier)) {
        if (!rule.packages(specifier)) found.push(`${relative(ROOT, file)} imports "${specifier}", which ${relative(ROOT, rule.folder)} may not`);
      } else if (!rule.inside.some(folder => within(resolve(dirname(file), specifier), folder))) {
        found.push(`${relative(ROOT, file)} imports "${specifier}", outside ${rule.inside.map(f => relative(ROOT, f)).join(' and ')}`);
      }
    }
    if (!bare(specifier)) {
      const target = resolve(dirname(file), specifier).replace(/\.(ts|js)$/, '');
      if (target === SQL_LAYER.replace(/\.ts$/, '') && !within(file, join(PACKAGES, 'core/store'))) {
        found.push(`${relative(ROOT, file)} imports the SQL layer (${relative(ROOT, SQL_LAYER)}); only src/core/store may`);
      }
    }
  }
  return found;
}

const SCANNED = [PACKAGES, join(ROOT, 'test'), join(ROOT, 'scripts'), join(ROOT, 'examples')];

describe('the import boundary', () => {
  test('every file of src/ imports only what its folder may', () => {
    const found = files(PACKAGES).flatMap(file => violations(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  test('no file outside src/core/store imports the SQL layer', () => {
    const found = SCANNED.flatMap(dir => files(dir)).flatMap(file => violations(file, readFileSync(file, 'utf8')).filter(v => v.includes('SQL layer')));
    expect(found).toEqual([]);
  });

  test('the check itself: a forbidden import is reported, naming the file', () => {
    const imp = (path: string) => ['import x from ', `'${path}';`].join('');
    expect(violations(join(PACKAGES, 'core/a.ts'), imp('../../host/store.ts'))).toEqual([
      expect.stringContaining('src/core/a.ts imports "../../host/store.ts", outside src/core')
    ]);
    expect(violations(join(PACKAGES, 'core/a.ts'), imp('zod'))).toEqual([expect.stringContaining('src/core/a.ts imports "zod"')]);
    expect(violations(join(PACKAGES, 'core/a.ts'), imp('../auth/index.ts'))).toHaveLength(1);
    expect(violations(join(PACKAGES, 'admin/a.ts'), imp('../core/index.ts'))).toEqual([]);
    expect(violations(join(PACKAGES, 'admin/a.ts'), imp('../auth/index.ts'))).toHaveLength(1);
    expect(violations(join(PACKAGES, 'auth/a.ts'), imp('../core/index.ts'))).toHaveLength(1);
    expect(violations(join(PACKAGES, 'auth/a.ts'), imp('hono/cookie'))).toEqual([]);
    expect(violations(join(PACKAGES, 'core/store/a.ts'), imp('./sql.ts'))).toEqual([]);
    expect(violations(join(PACKAGES, 'core/media/a.ts'), imp('../store/sql.ts'))).toEqual([expect.stringContaining('src/core/media/a.ts imports the SQL layer')]);
    expect(violations(join(ROOT, 'examples/a.ts'), imp('../src/core/store/sql'))).toEqual([expect.stringContaining('examples/a.ts imports the SQL layer')]);
    expect(violations(join(ROOT, 'examples/a.ts'), ['export * from ', "'../src/core/store/sql.ts';"].join(''))).toHaveLength(1);
    expect(violations(join(ROOT, 'examples/a.ts'), imp('../src/core/index.ts'))).toEqual([]);
  });
});

describe('core has three runtime dependencies', () => {
  const imported = () => {
    const set = new Set<string>();
    for (const file of files(join(PACKAGES, 'core'))) for (const s of specifiers(readFileSync(file, 'utf8'))) if (bare(s)) set.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!);
    return [...set].sort();
  };

  test('hono, @casl/ability and @cfworker/json-schema are the only packages core imports', () => {
    expect(imported()).toEqual(['@casl/ability', '@cfworker/json-schema', 'hono']);
  });

  test('a fourth package fails the check', () => {
    expect(violations(join(PACKAGES, 'core/x.ts'), ['import { z } from ', "'zod/v4';"].join(''))).toHaveLength(1);
  });

  test('package.json declares them, @casl/ability at an exact version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@casl/ability', '@cfworker/json-schema', 'hono']);
    expect(pkg.dependencies['@casl/ability']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the example host', () => {
  test('imports the package by its entry points, never by a path into src', () => {
    const found = files(join(ROOT, 'examples'))
      .flatMap(file => specifiers(readFileSync(file, 'utf8')).map(s => [relative(ROOT, file), s] as const))
      .filter(([, s]) => s.startsWith('.') && /src\//.test(s));
    expect(found).toEqual([]);
  });
});
