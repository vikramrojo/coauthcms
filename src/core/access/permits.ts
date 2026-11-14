/**
 * The rules in a form a page can use to show or hide controls. `cms.access.rulesFor`
 * packs a caller's grants into plain JSON, and `permits` answers from that JSON
 * alone. It is for display: enforcement is the store's, and the policy test
 * helper checks that the two agree.
 */
import type { Operation } from '../errors.ts';
import type { Grant } from './can.ts';
import { normaliseScalar, type Scalar, type Where } from './where.ts';

export interface PackedTypeRules {
  type: string;
  grants: Grant[];
}

export type PackedRules = PackedTypeRules[];

/** Whether a row satisfies a condition; the row holds the built-in columns and the indexed fields. */
export function matches(where: Where, row: Record<string, unknown>): boolean {
  const keys = Object.keys(where);
  if (keys[0] === 'and') return (where as { and: Where[] }).and.every(w => matches(w, row));
  if (keys[0] === 'or') return (where as { or: Where[] }).or.some(w => matches(w, row));
  return Object.entries(where as Record<string, Scalar | { in: Scalar[] }>).every(([field, value]) => {
    const actual = row[field];
    if (typeof value === 'object') return value.in.some(v => normaliseScalar(v) === actual);
    return normaliseScalar(value) === actual;
  });
}

/**
 * Whether the packed rules give the caller the operation on the type: on any row when `row` is left out, on that
 * row otherwise. A slug lookup is `operation: 'lookup'`.
 */
export function permits(rules: PackedRules, type: string, operation: Operation | 'lookup', row?: Record<string, unknown>): boolean {
  const grants = rules.find(r => r.type === type)?.grants ?? [];
  const wanted = grants.filter(g =>
    operation === 'lookup' ? g.operation === 'read' : g.operation === operation && !g.bySlug
  );
  return wanted.some(g => row === undefined || g.where === undefined || matches(g.where, row));
}

/** What a grant lists by name for a row: undefined when no matching grant, the list otherwise. */
export function pack(type: string, grants: readonly Grant[]): PackedTypeRules {
  return { type, grants: JSON.parse(JSON.stringify(grants)) as Grant[] };
}
