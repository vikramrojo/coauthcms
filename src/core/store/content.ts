/**
 * `content.as(principal)`: every read and write of entries, each carrying the
 * caller's compiled access condition. There is no variant without a caller, and
 * the SQL itself is in sql.ts, reached from nowhere else.
 */
import { Validator } from '@cfworker/json-schema';
import { compileAny, type ColumnOf, type Sql } from '../access/compile.ts';
import { RuleSet, type RuleRow } from '../access/ability.ts';
import { runAccess } from '../access/can.ts';
import { compileWhen, type ReadField } from '../access/when.ts';
import { compileWhere } from '../access/compile.ts';
import { isBuiltin, normaliseScalar } from '../access/where.ts';
import type { ContentType } from '../config/define.ts';
import type { FieldBuilder } from '../config/field.ts';
import { indexedColumn } from '../columns.ts';
import { ConditionError, ConfigError, Conflict, Forbidden, TooManyChildren, TooManyEntries, ValidationError, WriteRefused, type Operation } from '../errors.ts';
import type { HostPrincipal, Principal } from '../principal.ts';
import * as sql from './sql.ts';
import type {
  ContentApi, CreateInput, Entry, ListOptions, Status, TypeRef, UpdateEachChange, UpdatePatch, UpdateResult, When, WriteContext, WriteOptions
} from './types.ts';

export interface Internals {
  db: D1Database;
  types: ReadonlyMap<string, ContentType<any>>;
  maxMirrorChildren: number;
  maxUpdateEach: number;
  newId: () => string;
  /** Resolves once the database has the columns the types need; rejects naming the type and field when it does not. */
  ensureReady: () => Promise<void>;
}

/** Fields an entry has that no write may name, and the columns a rule may let a caller write by name. */
const NEVER_WRITABLE = ['status', 'parent_status', 'created_at', 'updated_at', 'publish_at', 'type', 'content_type'];
const PROTECTED_COLUMNS = ['owner_id', 'slug', 'parent_id', 'sort_key'] as const;
type ProtectedColumn = (typeof PROTECTED_COLUMNS)[number];
const isProtected = (key: string): key is ProtectedColumn => (PROTECTED_COLUMNS as readonly string[]).includes(key);

export const columnOf = (type: ContentType<any>): ColumnOf => field =>
  isBuiltin(field) ? field : type.indexed.includes(field) ? indexedColumn(field) : null;

const readField = (type: ContentType<any>): ReadField => field =>
  isBuiltin(field) ? field : field in type.fields ? `json_extract(data, '$.${field}')` : null;

/** An entry as the rules see it: the built-in columns and the values of the indexed fields. */
export function ruleRow(type: ContentType<any>, e: Pick<Entry, 'id' | 'owner_id' | 'slug' | 'status' | 'parent_id' | 'parent_status' | 'data'>): RuleRow {
  const row: RuleRow = { id: e.id, owner_id: e.owner_id, slug: e.slug, status: e.status, parent_id: e.parent_id, parent_status: e.parent_status };
  for (const field of type.indexed) {
    const value = e.data[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') row[field] = normaliseScalar(value);
  }
  return row;
}

const validators = new WeakMap<FieldBuilder<any, any>, Validator>();
function validatorOf(builder: FieldBuilder<any, any>): Validator {
  let v = validators.get(builder);
  if (!v) {
    v = new Validator(builder.schema, '7');
    validators.set(builder, v);
  }
  return v;
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ''}`);
}

export class Content implements ContentApi {
  private readonly ruleSets = new Map<string, RuleSet>();

  constructor(
    private readonly core: Internals,
    private readonly principal: Principal<HostPrincipal>
  ) {}

  // ── Rules ──────────────────────────────────────────────────────────

  private type(ref: TypeRef): ContentType<any> {
    const id = typeof ref === 'string' ? ref : ref.id;
    const type = this.core.types.get(id);
    if (!type) throw new ConfigError(`Unknown content type "${id}".`, id);
    if (type.service) throw new ConfigError(`Type "${id}" is an external collection; it is not stored as entries.`, id);
    return type;
  }

  private rules(type: ContentType<any>): RuleSet {
    let rules = this.ruleSets.get(type.id);
    if (!rules) {
      rules = new RuleSet(type.id, type.access ? runAccess(type.access, this.principal) : []);
      this.ruleSets.set(type.id, rules);
    }
    return rules;
  }

  /** The caller's condition for an operation as SQL, or null when no grant gives it. */
  private condition(type: ContentType<any>, operation: Operation, lookup = false): Sql | null {
    const grants = this.rules(type).grants.filter(g => (lookup ? g.operation === 'read' : g.operation === operation && !g.bySlug));
    try {
      const compiled = compileAny(grants.map(g => g.where), columnOf(type));
      return compiled && { sql: `(${compiled.sql})`, params: compiled.params };
    } catch (error) {
      if (error instanceof ConditionError) throw new ConditionError(`Type "${type.id}": ${error.message}`, error.field);
      throw error;
    }
  }

  private whenSql(type: ContentType<any>, when: When | undefined): Sql | null {
    if (when === undefined) return null;
    try {
      const compiled = compileWhen(when, readField(type));
      return { sql: `(${compiled.sql})`, params: compiled.params };
    } catch (error) {
      if (error instanceof ConditionError) throw new ConditionError(`Type "${type.id}": ${error.message}`, error.field);
      throw error;
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────

  async list<D = Record<string, unknown>>(ref: TypeRef, options: ListOptions = {}): Promise<Entry<D>[]> {
    const type = this.type(ref);
    const access = this.condition(type, 'read');
    if (!access) return [];
    const conditions = [access];
    if (options.where !== undefined) {
      try {
        const extra = compileWhere(options.where, columnOf(type));
        conditions.push({ sql: `(${extra.sql})`, params: extra.params });
      } catch (error) {
        if (error instanceof ConditionError) throw new ConditionError(`Type "${type.id}": ${error.message}`, error.field);
        throw error;
      }
    }
    await this.core.ensureReady();
    return sql.selectEntries<D>(this.core.db, type.id, conditions, {
      orderBy: options.orderBy,
      direction: options.direction,
      limit: Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000),
      offset: Math.max(Math.trunc(options.offset ?? 0), 0)
    });
  }

  async get<D = Record<string, unknown>>(ref: TypeRef, id: string): Promise<Entry<D> | null> {
    const type = this.type(ref);
    const access = this.condition(type, 'read');
    if (!access) return null;
    await this.core.ensureReady();
    return sql.selectOne<D>(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
  }

  async getBySlug<D = Record<string, unknown>>(ref: TypeRef, slug: string): Promise<Entry<D> | null> {
    const type = this.type(ref);
    const access = this.condition(type, 'read', true);
    if (!access) return null;
    await this.core.ensureReady();
    return sql.selectOne<D>(this.core.db, type.id, [{ sql: 'slug = ?', params: [slug] }, access]);
  }

  // ── Create ─────────────────────────────────────────────────────────

  async create<D = Record<string, unknown>>(ref: TypeRef, input: CreateInput): Promise<Entry<D>> {
    const type = this.type(ref);
    const rules = this.rules(type);
    if (!rules.has('create')) throw new Forbidden('create', type.id);
    const { builtins, data } = this.split(type, 'create', input);
    if (type.owned && typeof builtins.owner_id !== 'string') {
      throw new ValidationError(type.id, [{ field: 'owner_id', message: 'An owned entry is created with an owner.' }]);
    }
    this.validate(type, data, false);
    await this.core.ensureReady();

    const parentStatus = await this.parentStatus(type, builtins.parent_id ?? null);
    const row = ruleRow(type, {
      id: builtins.id ?? '',
      owner_id: builtins.owner_id ?? null,
      slug: builtins.slug ?? null,
      status: 'draft',
      parent_id: builtins.parent_id ?? null,
      parent_status: parentStatus,
      data
    });
    if (!rules.allows('create', row)) throw new Forbidden('create', type.id);
    this.checkFields('create', type, rules, row, Object.keys(data));

    // Defaults go in after the field rules, so a creator is not asked to write a system field the store fills in.
    const stored = { ...data };
    for (const [name, builder] of Object.entries(type.fields) as [string, FieldBuilder<any, any>][]) {
      if (stored[name] === undefined && builder.meta.default !== undefined) stored[name] = builder.meta.default;
    }
    await this.before(type, { operation: 'create', existing: null, input });
    const id = builtins.id ?? this.core.newId();
    try {
      await sql
        .insertEntry(this.core.db, {
          id,
          type: type.id,
          owner_id: builtins.owner_id ?? null,
          slug: builtins.slug ?? null,
          parent_id: builtins.parent_id ?? null,
          sort_key: builtins.sort_key ?? null,
          mirrorParentType: type.mirrors.includes('status') ? (type.parent ?? null) : null,
          data: stored
        })
        .run();
    } catch (error) {
      if (uniqueViolation(error)) throw new Conflict(type.id, /entries\.id|PRIMARY/i.test(String((error as Error).message)) ? 'id' : 'slug');
      throw error;
    }
    const entry = (await sql.selectOne<D>(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }]))!;
    await this.after(type, { operation: 'create', existing: null, input, entry: entry as Entry });
    return entry;
  }

  // ── Update ─────────────────────────────────────────────────────────

  async update<D = Record<string, unknown>>(ref: TypeRef, id: string, patch: UpdatePatch, options: { when?: When } = {}): Promise<UpdateResult<D>> {
    const type = this.type(ref);
    const rules = this.rules(type);
    const access = this.condition(type, 'update');
    if (!access) throw new Forbidden('update', type.id);
    const { builtins, data } = this.split(type, 'update', patch);
    const when = this.whenSql(type, options.when);
    await this.core.ensureReady();

    // A row the caller's update grants do not match is refused the same whether or not it exists.
    const existing = await sql.selectOne(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
    if (!existing) throw new Forbidden('update', type.id);
    const row = ruleRow(type, existing);
    this.checkFields('update', type, rules, row, [...Object.keys(builtins), ...Object.keys(data)]);
    this.validate(type, data, true);

    await this.before(type, { operation: 'update', existing, input: patch });
    const change: sql.Change = { data, columns: { ...(builtins as Partial<Record<ProtectedColumn, string | null>>) } };
    if (Object.keys(change.columns ?? {}).length === 0) delete change.columns;
    else if ('parent_id' in (change.columns ?? {})) change.mirrorParentType = type.mirrors.includes('status') ? (type.parent ?? null) : null;
    const result = await this.run(sql.updateEntry(this.core.db, type.id, id, change, access, when), type);
    if (result === 0) {
      // Still ours to update but not changed: the precondition did not hold. Otherwise it moved out of the caller's reach.
      const still = await sql.selectOne(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
      if (still && when) return { applied: false, reason: 'precondition' };
      throw new Forbidden('update', type.id);
    }
    const entry = (await sql.selectOne<D>(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }]))!;
    await this.after(type, { operation: 'update', existing, input: patch, entry: entry as Entry });
    return { applied: true, entry };
  }

  /**
   * Many entries of one type in one write. Every row is read once (ids in chunks) under the caller's update condition;
   * a row they may not update, or that does not exist, fails the call. Each patch meets `update`'s field rules and the
   * type's `beforeWrite`; then one batch holds a guard per chunk (it fails the batch, and so rolls it back, unless every
   * row is still reachable) and one UPDATE per row, each carrying the access condition. `afterWrite` runs per row.
   */
  async updateEach<D = Record<string, unknown>>(ref: TypeRef, changes: UpdateEachChange[]): Promise<Entry<D>[]> {
    const type = this.type(ref);
    const rules = this.rules(type);
    const access = this.condition(type, 'update');
    if (!access) throw new Forbidden('update', type.id);
    if (changes.length > this.core.maxUpdateEach) throw new TooManyEntries(type.id, changes.length, this.core.maxUpdateEach);
    const ids = changes.map(c => c.id);
    if (new Set(ids).size !== ids.length) throw new ValidationError(type.id, [{ field: 'id', message: 'is listed more than once.' }]);
    const split = changes.map(c => ({ ...c, ...this.split(type, 'update', c.patch) }));
    if (changes.length === 0) return [];
    await this.core.ensureReady();

    const size = sql.idChunkSize(access);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
    const existing = new Map<string, Entry>();
    for (const chunk of chunks) for (const e of await sql.selectByIds(this.core.db, type.id, chunk, [access])) existing.set(e.id, e);
    // A row the caller's update grants do not match is refused the same whether or not it exists.
    if (ids.some(id => !existing.has(id))) throw new Forbidden('update', type.id);

    for (const c of split) {
      this.checkFields('update', type, rules, ruleRow(type, existing.get(c.id)!), [...Object.keys(c.builtins), ...Object.keys(c.data)]);
      this.validate(type, c.data, true);
    }
    for (const c of split) await this.before(type, { operation: 'update', existing: existing.get(c.id)!, input: c.patch });

    const statements = [
      ...chunks.map(chunk => sql.assertReachable(this.core.db, type.id, chunk, access)),
      ...split.map(c => {
        const change: sql.Change = { data: c.data, columns: { ...(c.builtins as Partial<Record<ProtectedColumn, string | null>>) } };
        if (Object.keys(change.columns ?? {}).length === 0) delete change.columns;
        else if ('parent_id' in (change.columns ?? {})) change.mirrorParentType = type.mirrors.includes('status') ? (type.parent ?? null) : null;
        return sql.updateEntry(this.core.db, type.id, c.id, change, access, null);
      })
    ];
    try {
      await this.core.db.batch(statements);
    } catch (error) {
      if (sql.isUnreachable(error)) throw new Forbidden('update', type.id);
      throw error;
    }

    const written = new Map<string, Entry<D>>();
    for (const chunk of chunks) for (const e of await sql.selectByIds<D>(this.core.db, type.id, chunk, [])) written.set(e.id, e);
    const entries: Entry<D>[] = [];
    for (const c of split) {
      const entry = written.get(c.id)!;
      await this.after(type, { operation: 'update', existing: existing.get(c.id)!, input: c.patch, entry: entry as Entry });
      entries.push(entry);
    }
    return entries;
  }

  // ── Publish and unpublish ──────────────────────────────────────────

  publish<D = Record<string, unknown>>(ref: TypeRef, id: string, options: WriteOptions = {}) {
    return this.setStatus<D>(ref, id, 'published', options);
  }

  unpublish<D = Record<string, unknown>>(ref: TypeRef, id: string, options: WriteOptions = {}) {
    return this.setStatus<D>(ref, id, 'draft', options);
  }

  private async setStatus<D>(ref: TypeRef, id: string, status: Status, options: WriteOptions): Promise<UpdateResult<D>> {
    const type = this.type(ref);
    const operation = status === 'published' ? 'publish' : 'unpublish';
    const rules = this.rules(type);
    const access = this.condition(type, 'publish');
    if (!access) throw new Forbidden(operation, type.id);
    const set = options.set ?? {};
    const { builtins, data } = this.split(type, operation, set);
    if (Object.keys(builtins).length > 0) throw new Forbidden(operation, type.id, Object.keys(builtins)[0]);
    const when = this.whenSql(type, options.when);
    await this.core.ensureReady();

    const existing = await sql.selectOne(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
    if (!existing) throw new Forbidden(operation, type.id);
    const permitted = rules.permittedFields('publish', ruleRow(type, existing));
    for (const key of Object.keys(data)) if (!permitted.listed.has(key)) throw new Forbidden(operation, type.id, key);
    this.validate(type, data, true);

    const childTypes = [...this.core.types.values()].filter(c => c.parent === type.id && c.mirrors.includes('status') && !c.service).map(c => c.id);
    const children = await sql.countChildren(this.core.db, childTypes, id);
    if (children > this.core.maxMirrorChildren) throw new TooManyChildren(type.id, children, this.core.maxMirrorChildren);

    await this.before(type, { operation, existing, input: set });
    const results = await this.core.db.batch([
      sql.updateEntry(this.core.db, type.id, id, { status, data }, access, when),
      ...childTypes.map(child => sql.mirrorChildren(this.core.db, child, id, status))
    ]);
    if (((results[0]?.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
      const still = await sql.selectOne(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
      if (still && when) return { applied: false, reason: 'precondition' };
      throw new Forbidden(operation, type.id);
    }
    const entry = (await sql.selectOne<D>(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }]))!;
    await this.after(type, { operation, existing, input: set, entry: entry as Entry });
    return { applied: true, entry };
  }

  // ── Remove ─────────────────────────────────────────────────────────

  async remove(ref: TypeRef, id: string): Promise<void> {
    const type = this.type(ref);
    const access = this.condition(type, 'delete');
    if (!access) throw new Forbidden('delete', type.id);
    await this.core.ensureReady();
    const existing = await sql.selectOne(this.core.db, type.id, [{ sql: 'id = ?', params: [id] }, access]);
    if (!existing) throw new Forbidden('delete', type.id);
    await this.before(type, { operation: 'delete', existing, input: {} });
    if ((await this.run(sql.deleteEntry(this.core.db, type.id, id, access), type)) === 0) throw new Forbidden('delete', type.id);
    await this.after(type, { operation: 'delete', existing, input: {}, entry: null });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async run(statement: D1PreparedStatement, _type: ContentType<any>): Promise<number> {
    const result = await statement.run();
    return (result.meta as { changes?: number }).changes ?? 0;
  }

  private async parentStatus(type: ContentType<any>, parentId: string | null): Promise<Status | null> {
    if (!type.mirrors.includes('status') || !type.parent || parentId === null) return null;
    return (await sql.selectOne(this.core.db, type.parent, [{ sql: 'id = ?', params: [parentId] }]))?.status ?? null;
  }

  /** Splits a write into the built-in columns it names and the type's own fields; refuses what no write may name. */
  private split(type: ContentType<any>, operation: Operation | 'unpublish', input: Record<string, unknown>) {
    const builtins: { id?: string; owner_id?: string | null; slug?: string | null; parent_id?: string | null; sort_key?: string | null } = {};
    const data: Record<string, unknown> = {};
    const unknown: { field: string; message: string }[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (NEVER_WRITABLE.includes(key)) throw new Forbidden(operation, type.id, key);
      if (key === 'id' && operation === 'create') builtins.id = value as string;
      else if (isProtected(key)) {
        if (value !== null && typeof value !== 'string') unknown.push({ field: key, message: 'must be a string or null.' });
        (builtins as Record<string, unknown>)[key] = value;
      } else if (key in type.fields) data[key] = value;
      else unknown.push({ field: key, message: `"${key}" is not a field of ${type.id}.` });
    }
    if (unknown.length > 0) throw new ValidationError(type.id, unknown);
    return { builtins, data };
  }

  /** Field rules: ordinary fields need a grant with no field list or one that names them; system fields and protected columns need to be named. */
  private checkFields(operation: 'create' | 'update', type: ContentType<any>, rules: RuleSet, row: RuleRow, keys: string[]) {
    const permitted = rules.permittedFields(operation, row);
    for (const key of keys) {
      const named = permitted.listed.has(key);
      if (isProtected(key)) {
        // A new entry is given its owner, slug and parent by the create grant's own condition; an update needs the column named.
        if (operation === 'update' && !named) throw new Forbidden(operation, type.id, key);
      } else if (type.fields[key]!.meta.system) {
        if (!named) throw new Forbidden(operation, type.id, key);
      } else if (!permitted.ordinary && !named) {
        throw new Forbidden(operation, type.id, key);
      }
    }
  }

  private validate(type: ContentType<any>, data: Record<string, unknown>, partial: boolean) {
    const issues: { field: string; message: string }[] = [];
    for (const [name, builder] of Object.entries(type.fields) as [string, FieldBuilder<any, any>][]) {
      const value = data[name];
      if (value === undefined && partial) continue;
      if (value === undefined || value === null) {
        if (builder.meta.required) issues.push({ field: name, message: 'is required.' });
        continue;
      }
      const result = validatorOf(builder).validate(value);
      if (!result.valid) issues.push({ field: name, message: result.errors[result.errors.length - 1]?.error ?? 'is not valid.' });
    }
    if (issues.length > 0) throw new ValidationError(type.id, issues);
  }

  private context(type: ContentType<any>, base: Pick<WriteContext, 'operation' | 'existing' | 'input'>): WriteContext {
    return {
      ...base,
      type: type.id,
      principal: Object.freeze({ ...this.principal }),
      // The hook calls the store as the caller it is running for, so it cannot do what the rules refuse.
      content: this,
      refuse: (message: string): never => {
        throw new WriteRefused(type.id, message);
      }
    };
  }

  private async before(type: ContentType<any>, base: Pick<WriteContext, 'operation' | 'existing' | 'input'>) {
    await type.beforeWrite?.(this.context(type, base));
  }

  private async after(type: ContentType<any>, base: Pick<WriteContext, 'operation' | 'existing' | 'input'> & { entry: Entry | null }) {
    if (!type.afterWrite) return;
    const { refuse: _refuse, ...context } = this.context(type, base);
    await type.afterWrite({ ...context, entry: base.entry });
  }
}
