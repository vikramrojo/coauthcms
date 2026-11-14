#!/usr/bin/env bun
/**
 * Prints the SQL a config's content types need in `entries`: a virtual generated
 * column and an index for each indexed field, and a unique index on the slug for
 * the types that ask for one. The host's own migration holds these lines and startup checks the columns exist.
 *
 *   bunx cogens-print-migration site.config.ts
 *   bun run node_modules/cogens/scripts/print-migration.ts site.config.ts
 *
 * The config file's default export is `{ contentTypes }` (what `defineConfig` returns).
 */
import type { ContentType } from '../src/core/config/define.ts';
import { indexedColumn } from '../src/core/columns.ts';

/** `ALTER TABLE ... ADD COLUMN` allows only VIRTUAL generated columns; SQLite can index them. */
export function migrationLines(types: readonly ContentType<any>[]): string[] {
  const lines: string[] = [];
  const done = new Set<string>();
  for (const type of types) {
    if (type.service) continue;
    for (const field of type.indexed) {
      const column = indexedColumn(field);
      if (done.has(column)) continue;
      done.add(column);
      lines.push(`ALTER TABLE entries ADD COLUMN ${column} GENERATED ALWAYS AS (json_extract(data, '$.${field}')) VIRTUAL;`);
      lines.push(`CREATE INDEX IF NOT EXISTS idx_entries_${column} ON entries(content_type, ${column});`);
    }
  }
  const unique = types.filter(t => !t.service && t.uniqueSlug).map(t => `'${t.id}'`);
  if (unique.length > 0) {
    lines.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique_slug ON entries(content_type, slug) WHERE slug IS NOT NULL AND content_type IN (${unique.join(', ')});`
    );
  }
  return lines;
}

// Run under Bun; the declarations keep this file free of Node's types, which a Worker build does not have.
declare const process: { argv: string[]; cwd(): string; exit(code: number): never };

if ((import.meta as { main?: boolean }).main) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: bunx cogens-print-migration <config file>');
    process.exit(1);
  }
  const module = await import(new URL(path, `file://${process.cwd()}/`).href);
  const config = module.default as { contentTypes: ContentType<any>[] };
  console.log(migrationLines(config.contentTypes).join('\n'));
}
