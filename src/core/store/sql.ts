/**
 * The SQL layer: the only file that names the tables that hold entries and
 * assets. Everything else reaches them through the functions here, and a test
 * fails on any file outside src/core/store that imports this one. Every
 * function takes the access condition already compiled; there is no variant that
 * leaves it out.
 */
import { ConditionError } from '../errors.ts';
import { MAX_IN_VALUES } from '../access/where.ts';
import type { Sql } from '../access/compile.ts';
import type { Entry, OrderBy, Status } from './types.ts';

/** D1 allows 100 bound values in one statement. */
const MAX_PARAMS = 100;

const SELECT = 'SELECT id, content_type, owner_id, slug, status, parent_id, sort_key, parent_status, data, created_at, updated_at FROM entries';

function bind(db: D1Database, sql: string, params: unknown[]): D1PreparedStatement {
  if (params.length > MAX_PARAMS) {
    throw new ConditionError(`One statement binds ${params.length} values; D1 allows ${MAX_PARAMS}. Narrow the condition.`);
  }
  return db.prepare(sql).bind(...params);
}

interface Row {
  id: string;
  content_type: string;
  owner_id: string | null;
  slug: string | null;
  status: string;
  parent_id: string | null;
  sort_key: string | null;
  parent_status: string | null;
  data: string;
  created_at: string;
  updated_at: string;
}

export function toEntry<D = Record<string, unknown>>(row: Row): Entry<D> {
  return {
    id: row.id,
    type: row.content_type,
    owner_id: row.owner_id,
    slug: row.slug,
    status: row.status as Status,
    parent_id: row.parent_id,
    sort_key: row.sort_key,
    parent_status: row.parent_status as Status | null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    data: JSON.parse(row.data) as D
  };
}

const ORDER_COLUMNS: Record<OrderBy, string> = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  sort_key: 'sort_key',
  slug: 'slug'
};

export interface SelectOptions {
  orderBy?: OrderBy;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** Entries of one type that match every condition given (each already compiled). */
export async function selectEntries<D = Record<string, unknown>>(db: D1Database, type: string, conditions: Sql[], options: SelectOptions = {}): Promise<Entry<D>[]> {
  const order = ORDER_COLUMNS[options.orderBy ?? 'created_at'];
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
  const sql = `${SELECT} WHERE content_type = ?${conditions.map(c => ` AND ${c.sql}`).join('')} ORDER BY ${order} ${direction}, id LIMIT ? OFFSET ?`;
  const params = [type, ...conditions.flatMap(c => c.params), options.limit ?? 100, options.offset ?? 0];
  const result = await bind(db, sql, params).all<Row>();
  return (result.results ?? []).map(r => toEntry<D>(r));
}

/** How many ids one statement may name beside the type, the access condition and (for a read) a limit and an offset. */
export function idChunkSize(access: Sql): number {
  return Math.max(1, Math.min(MAX_IN_VALUES, MAX_PARAMS - 3 - access.params.length));
}

const inList = (ids: string[]): Sql => ({ sql: `id IN (${ids.map(() => '?').join(', ')})`, params: ids });

/** The entries of one type with these ids (at most `idChunkSize` of them) that the access condition lets through. */
export function selectByIds<D = Record<string, unknown>>(db: D1Database, type: string, ids: string[], conditions: Sql[]): Promise<Entry<D>[]> {
  return selectEntries<D>(db, type, [inList(ids), ...conditions], { orderBy: 'created_at', limit: ids.length });
}

/**
 * A statement that fails the whole batch it is in (SQLite's "integer overflow") unless every one of these ids is an
 * entry of the type that the access condition lets through. A batch is one transaction, so it checks the rows at the
 * moment the writes after it run, and a failure rolls back the writes before it.
 */
export function assertReachable(db: D1Database, type: string, ids: string[], access: Sql): D1PreparedStatement {
  return bind(
    db,
    `SELECT CASE WHEN (SELECT COUNT(*) FROM entries WHERE content_type = ? AND ${inList(ids).sql} AND ${access.sql}) = ? THEN 1 ELSE abs(-9223372036854775807 - 1) END`,
    [type, ...ids, ...access.params, ids.length]
  );
}

/** True when an error from `assertReachable` is what a batch failed with. */
export const isUnreachable = (error: unknown): boolean =>
  error instanceof Error && /integer overflow/i.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ''}`);

export async function selectOne<D = Record<string, unknown>>(db: D1Database, type: string, conditions: Sql[]): Promise<Entry<D> | null> {
  const sql = `${SELECT} WHERE content_type = ?${conditions.map(c => ` AND ${c.sql}`).join('')} LIMIT 1`;
  const row = await bind(db, sql, [type, ...conditions.flatMap(c => c.params)]).first<Row>();
  return row ? toEntry<D>(row) : null;
}

export interface NewRow {
  id: string;
  type: string;
  owner_id: string | null;
  slug: string | null;
  parent_id: string | null;
  sort_key: string | null;
  /** The type of the parent whose status the entry mirrors; null when it mirrors nothing. */
  mirrorParentType: string | null;
  data: Record<string, unknown>;
}

export function insertEntry(db: D1Database, row: NewRow): D1PreparedStatement {
  const mirrored = row.mirrorParentType !== null && row.parent_id !== null;
  return bind(
    db,
    `INSERT INTO entries (id, content_type, owner_id, slug, status, parent_id, sort_key, parent_status, data)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ${mirrored ? '(SELECT status FROM entries WHERE id = ? AND content_type = ?)' : 'NULL'}, ?)`,
    [row.id, row.type, row.owner_id, row.slug, row.parent_id, row.sort_key, ...(mirrored ? [row.parent_id, row.mirrorParentType] : []), JSON.stringify(row.data)]
  );
}

export interface Change {
  /** Fields of `data`, replaced whole (null stores a JSON null). */
  data?: Record<string, unknown>;
  columns?: Partial<Record<'owner_id' | 'slug' | 'parent_id' | 'sort_key', string | null>>;
  status?: Status;
  /** Re-read parent_status from this parent type's entry (after parent_id changed in a type that mirrors). */
  mirrorParentType?: string | null;
}

/** An UPDATE of one entry, applied only where the access condition (and the precondition) hold. */
export function updateEntry(db: D1Database, type: string, id: string, change: Change, access: Sql, when: Sql | null): D1PreparedStatement {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (change.status !== undefined) {
    sets.push('status = ?');
    params.push(change.status);
  }
  const names = Object.keys(change.data ?? {});
  if (names.length > 0) {
    sets.push(`data = json_set(data${names.map(() => ", '$.' || ?, json(?)").join('')})`);
    for (const name of names) params.push(name, JSON.stringify((change.data as Record<string, unknown>)[name] ?? null));
  }
  for (const [column, value] of Object.entries(change.columns ?? {})) {
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (change.columns && 'parent_id' in change.columns) {
    if (change.mirrorParentType && change.columns.parent_id) {
      sets.push('parent_status = (SELECT status FROM entries WHERE id = ? AND content_type = ?)');
      params.push(change.columns.parent_id, change.mirrorParentType);
    } else {
      sets.push('parent_status = NULL');
    }
  }
  sets.push("updated_at = datetime('now')");
  const sql = `UPDATE entries SET ${sets.join(', ')} WHERE id = ? AND content_type = ? AND ${access.sql}${when ? ` AND ${when.sql}` : ''}`;
  return bind(db, sql, [...params, id, type, ...access.params, ...(when?.params ?? [])]);
}

export function deleteEntry(db: D1Database, type: string, id: string, access: Sql): D1PreparedStatement {
  return bind(db, `DELETE FROM entries WHERE id = ? AND content_type = ? AND ${access.sql}`, [id, type, ...access.params]);
}

/**
 * The children of a parent that mirror its status take the parent's status in the
 * same batch as the parent's own write. The update runs only while the parent holds
 * that status, so a parent write that matched no row copies nothing.
 */
export function mirrorChildren(db: D1Database, childType: string, parentId: string, status: Status): D1PreparedStatement {
  return bind(
    db,
    'UPDATE entries SET parent_status = ? WHERE content_type = ? AND parent_id = ? AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND status = ?)',
    [status, childType, parentId, parentId, status]
  );
}

export async function countChildren(db: D1Database, childTypes: string[], parentId: string): Promise<number> {
  if (childTypes.length === 0) return 0;
  const row = await bind(
    db,
    `SELECT COUNT(*) AS n FROM entries WHERE parent_id = ? AND content_type IN (${childTypes.map(() => '?').join(', ')})`,
    [parentId, ...childTypes]
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The columns of `entries`, with SQLite's `hidden` flag (2 and 3 are generated columns). */
export async function entryColumns(db: D1Database): Promise<{ name: string; hidden: number }[]> {
  const result = await db.prepare('PRAGMA table_xinfo(entries)').all<{ name: string; hidden: number }>();
  return (result.results ?? []).map(r => ({ name: r.name, hidden: r.hidden }));
}

// ── Assets ───────────────────────────────────────────────────────────

export interface AssetRow {
  id: string;
  owner_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const ASSET_SELECT = 'SELECT id, owner_id, data, created_at, updated_at FROM assets';

const toAsset = (r: { id: string; owner_id: string | null; data: string; created_at: string; updated_at: string }): AssetRow => ({
  ...r,
  data: JSON.parse(r.data) as Record<string, unknown>
});

export async function selectAssets(db: D1Database, access: Sql, id?: string): Promise<AssetRow[]> {
  const result = await bind(db, `${ASSET_SELECT} WHERE ${access.sql}${id === undefined ? '' : ' AND id = ?'} ORDER BY created_at DESC, id`, [
    ...access.params,
    ...(id === undefined ? [] : [id])
  ]).all<Parameters<typeof toAsset>[0]>();
  return (result.results ?? []).map(toAsset);
}

export function insertAsset(db: D1Database, row: { id: string; owner_id: string | null; data: Record<string, unknown> }): D1PreparedStatement {
  return bind(db, 'INSERT INTO assets (id, owner_id, data) VALUES (?, ?, ?)', [row.id, row.owner_id, JSON.stringify(row.data)]);
}

export function deleteAsset(db: D1Database, id: string, access: Sql): D1PreparedStatement {
  return bind(db, `DELETE FROM assets WHERE id = ? AND ${access.sql}`, [id, ...access.params]);
}
