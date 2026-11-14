/**
 * contentType, group, defineConfig, Infer: the schema definition API. A type
 * names its fields and, beyond Koguma's, whether its entries are owned, which
 * fields are indexed, who may do what (`access`), what a child mirrors of its
 * parent, and hooks around writes.
 */
import { ConfigError } from '../errors.ts';
import type { AccessFn } from '../access/can.ts';
import type { AfterWriteContext, WriteContext } from '../store/types.ts';
import { FieldBuilder, type FieldMeta } from './field.ts';

export interface GroupConfig {
  groupId: string;
  name: string;
  helpText?: string;
  collapsed?: boolean;
  fields: Record<string, FieldBuilder<any, any>>;
}

export function group(opts: {
  id: string;
  name: string;
  helpText?: string;
  collapsed?: boolean;
  fields: Record<string, FieldBuilder<any, any>>;
}): GroupConfig {
  return { groupId: opts.id, name: opts.name, helpText: opts.helpText, collapsed: opts.collapsed, fields: opts.fields };
}

/** An action the admin offers on one entry of an external collection. */
export interface ServiceAction {
  id: string;
  label: string;
  /** The confirmation text shown before the action runs. */
  confirm: string;
  method: 'POST' | 'DELETE';
  /** Path template; `:id` is the entry's id. */
  path: string;
  /** A content type to pick an entry of first; the body sent is `{ from: <this id>, into: <picked id> }`. */
  target?: string;
  destructive?: boolean;
}

/** An external collection: a read-only view over a table of the host's own, never stored as entries. */
export interface ServiceConfig {
  readOnly: true;
  actions?: ServiceAction[];
}

/** Names a column or a condition keyword may not be used as a field name for. */
export const RESERVED_FIELD_NAMES = [
  'id',
  'type',
  'content_type',
  'owner_id',
  'slug',
  'status',
  'parent_id',
  'parent_status',
  'sort_key',
  'publish_at',
  'created_at',
  'updated_at',
  'data',
  'and',
  'or',
  'in'
] as const;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const TYPE_ID = /^[a-z][A-Za-z0-9_-]*$/;

export type Fields = Record<string, FieldBuilder<any, any>>;

export interface ContentType<F extends Fields = Fields> {
  readonly id: string;
  readonly name: string;
  readonly displayField: string;
  readonly singleton?: boolean;
  /** Entries have an owner; the type must then have an `access` function. */
  readonly owned: boolean;
  /** Fields conditions may name; each becomes a generated column (print-migration.ts prints it). */
  readonly indexed: readonly string[];
  /** The slug is unique among this type's entries. */
  readonly uniqueSlug: boolean;
  /** The id of the type this type's entries are children of (`parent_id` names the entry). */
  readonly parent?: string;
  /** What a child copies from its parent in the same write that changes it. */
  readonly mirrors: readonly 'status'[];
  readonly access?: AccessFn<any>;
  readonly beforeWrite?: (context: WriteContext<any>) => void | Promise<void>;
  readonly afterWrite?: (context: AfterWriteContext<any>) => void | Promise<void>;
  readonly service?: ServiceConfig;
  /** Every field, flat. */
  readonly fields: F;
  readonly fieldMeta: Record<string, FieldMeta>;
  readonly groups: GroupConfig[];
  /** The fields of a type declared without groups. */
  readonly flatFields: Fields;
}

export interface ContentTypeOptions<F extends Fields | GroupConfig[]> {
  id: string;
  name: string;
  displayField: string;
  singleton?: boolean;
  owned?: boolean;
  indexed?: readonly string[];
  uniqueSlug?: boolean;
  parent?: string;
  mirrors?: readonly 'status'[];
  access?: AccessFn<any>;
  beforeWrite?: (context: WriteContext<any>) => void | Promise<void>;
  afterWrite?: (context: AfterWriteContext<any>) => void | Promise<void>;
  service?: ServiceConfig;
  fields: F;
}

export function contentType<F extends Fields | GroupConfig[]>(
  opts: ContentTypeOptions<F>
): ContentType<F extends GroupConfig[] ? Fields : Extract<F, Fields>> {
  if (!TYPE_ID.test(opts.id)) throw new ConfigError(`Type id "${opts.id}" must start with a lowercase letter and use letters, digits, - and _.`, opts.id);

  const all: Fields = {};
  const groups: GroupConfig[] = [];
  let flatFields: Fields = {};
  if (Array.isArray(opts.fields)) {
    for (const g of opts.fields) {
      groups.push(g);
      Object.assign(all, g.fields);
    }
  } else {
    flatFields = opts.fields as Fields;
    Object.assign(all, flatFields);
  }

  for (const name of Object.keys(all)) {
    if ((RESERVED_FIELD_NAMES as readonly string[]).includes(name)) {
      throw new ConfigError(
        `Field "${name}" of type "${opts.id}" collides with a built-in name (${RESERVED_FIELD_NAMES.join(', ')}); the built-in column of that name is used instead.`,
        opts.id,
        name
      );
    }
    if (!FIELD_NAME.test(name)) {
      throw new ConfigError(`Field "${name}" of type "${opts.id}" must start with a letter and use letters, digits and _.`, opts.id, name);
    }
  }
  const indexed = opts.indexed ?? [];
  for (const name of indexed) {
    if (!(name in all)) throw new ConfigError(`Type "${opts.id}" indexes "${name}", which is not one of its fields.`, opts.id, name);
  }
  if (new Set(indexed).size !== indexed.length) {
    throw new ConfigError(`Type "${opts.id}" lists an indexed field twice.`, opts.id);
  }
  if (opts.mirrors?.length && opts.parent === undefined) {
    throw new ConfigError(`Type "${opts.id}" mirrors its parent's status but names no parent.`, opts.id);
  }
  if (opts.displayField !== undefined && !(opts.displayField in all) && Object.keys(all).length > 0) {
    throw new ConfigError(`Type "${opts.id}" shows "${opts.displayField}", which is not one of its fields.`, opts.id, opts.displayField);
  }

  const fieldMeta: Record<string, FieldMeta> = {};
  for (const [name, builder] of Object.entries(all)) fieldMeta[name] = builder.meta;

  return {
    id: opts.id,
    name: opts.name,
    displayField: opts.displayField,
    singleton: opts.singleton,
    owned: opts.owned ?? false,
    indexed,
    uniqueSlug: opts.uniqueSlug ?? false,
    parent: opts.parent,
    mirrors: opts.mirrors ?? [],
    access: opts.access,
    beforeWrite: opts.beforeWrite,
    afterWrite: opts.afterWrite,
    service: opts.service,
    fields: all as never,
    fieldMeta,
    groups,
    flatFields
  };
}

export interface CmsConfig {
  siteName: string;
  contentTypes: ContentType<any>[];
}

export function defineConfig(config: CmsConfig): CmsConfig {
  return config;
}

// ── Infer ────────────────────────────────────────────────────────────

type Flatten<T> = { [K in keyof T]: T[K] } & {};
type RequiredKeys<F extends Fields> = { [K in keyof F]: F[K] extends FieldBuilder<any, true> ? K : never }[keyof F];
type OptionalKeys<F extends Fields> = Exclude<keyof F, RequiredKeys<F>>;

/** The type of an entry's `data`: required fields present, the rest optional. */
export type Infer<T extends ContentType<any>> =
  T extends ContentType<infer F>
    ? Flatten<{ [K in RequiredKeys<F>]: F[K]['_type'] } & { [K in OptionalKeys<F>]?: F[K]['_type'] | null }>
    : never;
