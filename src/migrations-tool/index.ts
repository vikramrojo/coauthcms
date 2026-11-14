/**
 * `cogens/migrations-tool`: the SQL a config's content types need in `entries`: a virtual generated
 * column and an index for each indexed field, and a unique index on the slug for
 * the types that ask for one. The host's own migration holds these lines and startup checks the columns exist.
 *
 * `cogens-print-migration <config>` (bin.ts) prints them for a config file:
 *
 *   bunx cogens-print-migration site.config.ts
 *   npx cogens-print-migration site.config.mjs
 *
 * The config file's default export is `{ contentTypes }` (what `defineConfig` returns).
 */
import type { ContentType } from '../core/config/define.ts';
import { indexedColumn } from '../core/columns.ts';

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
