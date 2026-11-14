/** The shapes the store takes and gives. Types only, so config and the store may name each other. */
import type { Operation } from '../errors.ts';
import type { Where } from '../access/where.ts';
import type { Principal, HostPrincipal } from '../principal.ts';

export type Status = 'draft' | 'published';

/** One entry. The built-in columns keep their column names, the type's own fields are in `data`. */
export interface Entry<D = Record<string, unknown>> {
  id: string;
  type: string;
  owner_id: string | null;
  slug: string | null;
  status: Status;
  parent_id: string | null;
  sort_key: string | null;
  /** The parent's status, for a type that mirrors it; null otherwise. */
  parent_status: Status | null;
  created_at: string;
  updated_at: string;
  data: D;
}

export type OrderBy = 'created_at' | 'updated_at' | 'sort_key' | 'slug';

export interface ListOptions {
  /** More conditions, ANDed to what the caller's rules allow (equals, `in`, `and`, `or` over built-in and indexed fields). */
  where?: Where;
  orderBy?: OrderBy;
  direction?: 'asc' | 'desc';
  /** At most 1000; 100 when absent. */
  limit?: number;
  offset?: number;
}

/** What `create` takes: the type's fields and the built-in `id`, `owner_id`, `slug`, `parent_id` and `sort_key`. */
export type CreateInput = Record<string, unknown>;

/** What `update` takes: the fields to change. `status` is never writable here; `owner_id`, `slug`, `parent_id` and `sort_key` only by a rule that lists them. */
export type UpdatePatch = Record<string, unknown>;

/** A precondition on an entry's current state, checked in the same statement as the write. */
export type Compare = { equals: unknown } | { lt: number } | { gt: number } | { isNull: boolean };
export type When = { or: When[] } | { [field: string]: Compare };

/** One entry's patch in an `updateEach`: the same fields an `update` takes. */
export interface UpdateEachChange {
  id: string;
  patch: UpdatePatch;
}

export interface WriteOptions {
  when?: When;
  /** Fields to set in the same statement as a publish or unpublish; only those the publish grant lists. */
  set?: UpdatePatch;
}

export type UpdateResult<D = Record<string, unknown>> =
  | { applied: true; entry: Entry<D> }
  | { applied: false; reason: 'precondition' };

/** A type given by id or by the object `contentType` returned. */
export type TypeRef = string | { readonly id: string };

export interface ContentApi {
  list<D = Record<string, unknown>>(type: TypeRef, options?: ListOptions): Promise<Entry<D>[]>;
  /** The entry, or null when it does not exist or the caller may not read it. */
  get<D = Record<string, unknown>>(type: TypeRef, id: string): Promise<Entry<D> | null>;
  getBySlug<D = Record<string, unknown>>(type: TypeRef, slug: string): Promise<Entry<D> | null>;
  create<D = Record<string, unknown>>(type: TypeRef, input: CreateInput): Promise<Entry<D>>;
  update<D = Record<string, unknown>>(type: TypeRef, id: string, patch: UpdatePatch, options?: { when?: When }): Promise<UpdateResult<D>>;
  /**
   * Several entries of one type updated in one write, all or nothing: every row must be one the caller may update, each
   * patch meets the rules `update` applies, and the hooks run per row. Returns the entries as written, in the order given.
   * More entries than the host's limit (500 by default) are refused with `TooManyEntries`.
   */
  updateEach<D = Record<string, unknown>>(type: TypeRef, changes: UpdateEachChange[]): Promise<Entry<D>[]>;
  remove(type: TypeRef, id: string): Promise<void>;
  publish<D = Record<string, unknown>>(type: TypeRef, id: string, options?: WriteOptions): Promise<UpdateResult<D>>;
  unpublish<D = Record<string, unknown>>(type: TypeRef, id: string, options?: WriteOptions): Promise<UpdateResult<D>>;
}

/** What a hook is told. `principal` is the caller; `content` is the store, as that same caller. */
export interface WriteContext<P = Principal<HostPrincipal>> {
  operation: Operation | 'unpublish';
  type: string;
  principal: P;
  /** The entry as it is before the write; null for a create. */
  existing: Entry | null;
  /** The fields being written. */
  input: Record<string, unknown>;
  content: ContentApi;
  /** Refuses the write with a message; nothing is stored. */
  refuse(message: string): never;
}

export interface AfterWriteContext<P = Principal<HostPrincipal>> extends Omit<WriteContext<P>, 'refuse'> {
  /** The entry as written; null after a remove. */
  entry: Entry | null;
}
