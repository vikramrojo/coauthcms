/** The package's migrations apply on a fresh database and on a Koguma one, with columns that can be indexed. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createDb, migrate, statements, type TestDb } from './support.ts';

let t: TestDb;
beforeEach(async () => {
  t = await createDb({ skipMigrations: true });
});
afterEach(() => t.dispose());

const columns = async () =>
  ((await t.db.prepare('PRAGMA table_xinfo(entries)').all<{ name: string; hidden: number }>()).results ?? []).map(r => `${r.name}:${r.hidden}`);
const names = async (type: 'table' | 'index') =>
  (await t.db.prepare('SELECT name FROM sqlite_master WHERE type = ?').bind(type).all<{ name: string }>()).results!.map(r => r.name);

test('applies to a fresh database: the ownership columns, the generated columns and their indexes, the auth tables', async () => {
  await migrate(t.db);
  const cols = await columns();
  for (const c of ['owner_id:0', 'parent_id:0', 'sort_key:0', 'parent_status:0', 'f_visibility:2', 'f_retired:2']) expect(cols).toContain(c);
  const assets = (await t.db.prepare('PRAGMA table_info(assets)').all<{ name: string }>()).results!.map(r => r.name);
  expect(assets).toContain('owner_id');
  const indexes = await names('index');
  for (const i of ['idx_entries_owner', 'idx_entries_parent', 'idx_assets_owner', 'idx_entries_f_visibility', 'idx_entries_f_retired', 'idx_entries_unique_slug']) {
    expect(indexes).toContain(i);
  }
  const tables = await names('table');
  for (const name of ['entries', 'assets', 'sessions', 'handoff_tokens', 'identities', 'auth_attempts', 'auth_meta']) expect(tables).toContain(name);
});

test('holds nothing of any host: no scores, owners or revisions tables, no generated columns', async () => {
  await migrate(t.db, undefined, null);
  const tables = await names('table');
  for (const name of ['scores', 'owners', 'revisions']) expect(tables).not.toContain(name);
  expect((await columns()).filter(c => c.startsWith('f_'))).toEqual([]);
});

test('the migrations can be applied twice', async () => {
  await migrate(t.db, undefined, null);
  await migrate(t.db, undefined, null);
});

test('koguma-upgrade.sql brings a Koguma database to the same columns, keeping its entries', async () => {
  // Koguma's own entries and assets tables, as its 0001 made them.
  await t.db.prepare("CREATE TABLE entries (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, slug TEXT, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', publish_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))").run();
  await t.db.prepare("CREATE TABLE assets (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))").run();
  await t.db.prepare("INSERT INTO entries (id, content_type, slug, data, status) VALUES ('p1', 'page', 'about', '{\"title\":\"About\",\"visibility\":\"public\"}', 'published')").run();
  await migrate(t.db, ['koguma-upgrade.sql', 'auth/0001_sessions.sql']);
  const upgraded = await columns();

  const fresh = await createDb();
  const freshColumns = ((await fresh.db.prepare('PRAGMA table_xinfo(entries)').all<{ name: string; hidden: number }>()).results ?? []).map(r => `${r.name}:${r.hidden}`);
  await fresh.dispose();
  expect([...upgraded].sort()).toEqual([...freshColumns].sort());

  const row = await t.db.prepare("SELECT slug, owner_id, f_visibility FROM entries WHERE id = 'p1'").first<Record<string, unknown>>();
  expect(row).toEqual({ slug: 'about', owner_id: null, f_visibility: 'public' });
  const plan = (await t.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM entries WHERE content_type = 'score' AND f_visibility = 'public'").all<{ detail: string }>()).results!;
  expect(plan.map(p => p.detail).join('\n')).toMatch(/idx_entries_f_visibility/);
});

test('the SQL files name no host table', () => {
  for (const file of ['0001_entries.sql', 'koguma-upgrade.sql', 'auth/0001_sessions.sql']) {
    expect(statements(file).length).toBeGreaterThan(3);
    for (const statement of statements(file)) expect(statement).not.toMatch(/\b(scores|owners|revisions)\b/i);
  }
});

test('a second score may not take a slug the first holds, but a page may share it', async () => {
  await migrate(t.db);
  const insert = (id: string, type: string, slug: string) =>
    t.db.prepare('INSERT INTO entries (id, content_type, slug, data) VALUES (?, ?, ?, ?)').bind(id, type, slug, '{}').run();
  await insert('a', 'score', 'x');
  await expect(insert('b', 'score', 'x')).rejects.toThrow(/UNIQUE/);
  await insert('c', 'page', 'x');
  await insert('d', 'other', 'x');
  await insert('e', 'other', 'x');
});
