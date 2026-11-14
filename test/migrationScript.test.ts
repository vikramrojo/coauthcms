/** Task 3.2: print-migration prints the column and index lines of a config, and startup checks them against the table. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConfigError, contentType, createCms, field } from '../src/core/index.ts';
import { migrationLines } from '../scripts/print-migration.ts';
import { admin, composer, page, score } from './sample.ts';
import { createDb, type TestDb } from './support.ts';

let t: TestDb;
beforeEach(async () => {
  t = await createDb();
});
afterEach(() => t.dispose());

describe('print-migration', () => {
  test('prints a generated column and an index per indexed field, and the unique slug index', () => {
    expect(migrationLines([score, page])).toEqual([
      "ALTER TABLE entries ADD COLUMN f_visibility GENERATED ALWAYS AS (json_extract(data, '$.visibility')) VIRTUAL;",
      'CREATE INDEX IF NOT EXISTS idx_entries_f_visibility ON entries(content_type, f_visibility);',
      "ALTER TABLE entries ADD COLUMN f_retired GENERATED ALWAYS AS (json_extract(data, '$.retired')) VIRTUAL;",
      'CREATE INDEX IF NOT EXISTS idx_entries_f_retired ON entries(content_type, f_retired);',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_unique_slug ON entries(content_type, slug) WHERE slug IS NOT NULL AND content_type IN ('score', 'page');"
    ]);
  });

  test('a field indexed by two types is printed once; an external collection adds nothing', () => {
    const a = contentType({ id: 'a', name: 'A', displayField: 'x', indexed: ['x'], fields: { x: field.text('X') } });
    const b = contentType({ id: 'b', name: 'B', displayField: 'x', indexed: ['x'], fields: { x: field.text('X') } });
    const c = contentType({ id: 'c', name: 'C', displayField: 'x', indexed: ['x'], service: { readOnly: true }, fields: { x: field.text('X') } });
    expect(migrationLines([a, b, c])).toHaveLength(2);
    expect(migrationLines([contentType({ id: 'd', name: 'D', displayField: 'x', fields: { x: field.text('X') } })])).toEqual([]);
  });

  test('the lines it prints apply to a database with the package migrations, and the startup check then passes', async () => {
    const db = await createDb({ printed: null });
    try {
      for (const line of migrationLines([score, page])) await db.db.prepare(line).run();
      await expect(createCms({ db: db.db, types: [score, page], probes: [composer('A')] }).verify()).resolves.toBeUndefined();
    } finally {
      await db.dispose();
    }
  });
});

describe('startup check against the table', () => {
  const make = () => createCms({ db: t.db, types: [score, page], probes: [composer('A')] });

  test('passes on the migrated database', async () => {
    await expect(make().verify()).resolves.toBeUndefined();
    expect(await make().content.as(admin()).list('score')).toEqual([]);
  });

  test('a dropped column fails naming the type and the field, on verify and on first use', async () => {
    await t.db.prepare('DROP INDEX idx_entries_f_retired').run();
    await t.db.prepare('ALTER TABLE entries DROP COLUMN f_retired').run();
    const cms = make();
    const error = await cms.verify().catch(e => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ type: 'score', field: 'retired' });
    expect(error.message).toContain('Type "score" indexes "retired"');
    await expect(cms.content.as(admin()).list('score')).rejects.toMatchObject({ type: 'score', field: 'retired' });
  });

  test('a missing ownership column fails too', async () => {
    await t.db.prepare('DROP INDEX idx_entries_owner').run();
    await t.db.prepare('DROP INDEX IF EXISTS idx_entries_unique_profile').run();
    await t.db.prepare('ALTER TABLE entries DROP COLUMN owner_id').run();
    await expect(make().verify()).rejects.toMatchObject({ field: 'owner_id' });
  });

  test('a database that was fixed passes on the next try', async () => {
    await t.db.prepare('DROP INDEX idx_entries_f_visibility').run();
    await t.db.prepare('ALTER TABLE entries DROP COLUMN f_visibility').run();
    const cms = make();
    await expect(cms.verify()).rejects.toBeInstanceOf(ConfigError);
    await t.db.prepare("ALTER TABLE entries ADD COLUMN f_visibility GENERATED ALWAYS AS (json_extract(data, '$.visibility')) VIRTUAL").run();
    await expect(cms.verify()).resolves.toBeUndefined();
  });
});
