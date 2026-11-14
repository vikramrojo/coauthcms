/**
 * What the pages show and hide, worked out from `cms.access.rulesFor`. This is
 * display only: a control that is hidden here is still refused by the store if
 * a request names it, and a control shown here is still checked there.
 */
import { permits, type ContentType, type Entry, type FieldMeta, type Operation, type PackedRules } from '../core/index.ts';

const PROTECTED = ['owner_id', 'slug', 'parent_id', 'sort_key'];

/** The row as a condition sees it: the built-in columns and the indexed fields (booleans as 0 and 1). */
export function ruleRow(type: ContentType<any>, entry: Entry): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: entry.id,
    owner_id: entry.owner_id,
    slug: entry.slug,
    status: entry.status,
    parent_id: entry.parent_id,
    parent_status: entry.parent_status
  };
  for (const field of type.indexed) {
    const value = entry.data[field];
    if (typeof value === 'boolean') row[field] = value ? 1 : 0;
    else if (typeof value === 'string' || typeof value === 'number') row[field] = value;
  }
  return row;
}

export const can = (rules: PackedRules, type: string, operation: Operation, row?: Record<string, unknown>) =>
  permits(rules, type, operation, row);

export interface Writable {
  /** Some matching grant lets the caller write every ordinary field. */
  ordinary: boolean;
  /** Fields a matching grant names (system fields and protected columns are writable only by name). */
  listed: Set<string>;
  /** Whether any grant matches at all. */
  any: boolean;
}

/** The fields a caller may write for create or update: those of the grants that match the row (any grant, for a create). */
export function writable(rules: PackedRules, type: string, operation: 'create' | 'update', row?: Record<string, unknown>): Writable {
  const grants = (rules.find(r => r.type === type)?.grants ?? []).filter(
    g => g.operation === operation && !g.bySlug && (row === undefined || permits([{ type, grants: [g] }], type, operation, row))
  );
  return {
    any: grants.length > 0,
    ordinary: grants.some(g => g.fields === undefined),
    listed: new Set(grants.flatMap(g => g.fields ?? []))
  };
}

/** Whether the caller may write one of the type's fields; false drawn as text. */
export function mayWrite(w: Writable, name: string, meta: FieldMeta): boolean {
  if (meta.fieldType === 'files') return false;
  if (meta.system) return w.listed.has(name);
  return w.ordinary || w.listed.has(name);
}

/** Whether the caller may write a built-in column (`slug`, `owner_id`); on create any create grant lets them name it. */
export function mayWriteColumn(w: Writable, name: string, operation: 'create' | 'update'): boolean {
  if (!PROTECTED.includes(name)) return false;
  return operation === 'create' ? w.any : w.listed.has(name);
}
