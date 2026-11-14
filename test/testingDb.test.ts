import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from '../src/testing/index.ts';
import { migrationLines } from '../src/migrations-tool/index.ts';

let t: TestDb | undefined;
afterEach(async () => { await t?.dispose(); t = undefined; });

test('createTestDb applies the package migrations, then the host files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogens-testdb-'));
  try {
    const file = join(dir, '0002_host.sql');
    writeFileSync(file, '-- host\nCREATE TABLE host_things (id TEXT PRIMARY KEY);\nINSERT INTO host_things (id) VALUES (\'a\');');
    t = await createTestDb({ migrations: [file] });
    expect((await t.db.prepare('SELECT count(*) AS n FROM host_things').first<{ n: number }>())?.n).toBe(1);
    expect((await t.db.prepare('SELECT count(*) AS n FROM entries').first<{ n: number }>())?.n).toBe(0);
    expect((await t.db.prepare('SELECT count(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the package exports the printer and the scripts by name', async () => {
  const tool = await import('cogens/migrations-tool');
  expect(tool.migrationLines([])).toEqual(migrationLines([]));
  expect(import.meta.resolve('cogens/scripts/build-admin-editor.ts')).toMatch(/scripts\/build-admin-editor\.ts$/);
  expect(import.meta.resolve('cogens')).toMatch(/dist\/core\/index\.js$/);
});
