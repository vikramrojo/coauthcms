/**
 * Conditions: the one vocabulary a rule uses to confine a grant to some rows.
 * Equality, membership in a list of at most 90 values, and `and` / `or`. The same
 * condition is compiled to SQL (compile.ts) and handed to the ability for the
 * in-memory answer (ability.ts), so a rule means the same in both.
 */
import { ConditionError } from '../errors.ts';

export type Scalar = string | number | boolean;

export type Where =
  | { and: Where[] }
  | { or: Where[] }
  | { [field: string]: Scalar | { in: Scalar[] } };

/** The most values one `in` may hold; D1 allows 100 bound values in a statement. */
export const MAX_IN_VALUES = 90;

/** The columns every entry has, which a condition may name without declaring them. */
export const BUILTIN_COLUMNS = ['id', 'owner_id', 'slug', 'status', 'parent_id', 'parent_status'] as const;
export type BuiltinColumn = (typeof BUILTIN_COLUMNS)[number];
export const isBuiltin = (field: string): field is BuiltinColumn => (BUILTIN_COLUMNS as readonly string[]).includes(field);

/** Booleans are stored as 0 and 1 in the column a generated field reads, so both sides use that. */
export const normaliseScalar = (value: Scalar): string | number => (typeof value === 'boolean' ? (value ? 1 : 0) : value);

function checkScalar(field: string, value: unknown): Scalar {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ConditionError(
    `The condition on "${field}" compares with ${value === null || value === undefined ? String(value) : typeof value}; use a string, number or boolean.`,
    field
  );
}

/** What a built-in column holds: text. A number there would be compared as text by SQL and as a number in memory. */
function checkColumnValue(field: string, value: Scalar): void {
  if (isBuiltin(field) && typeof value !== 'string') {
    throw new ConditionError(`The condition on "${field}" must compare with a string.`, field);
  }
}

/** Walks a condition, calling `onField` for each field it names; throws on anything outside the vocabulary. */
export function walkWhere(where: Where, onField: (field: string, value: Scalar | { in: Scalar[] }) => void): void {
  if (typeof where !== 'object' || where === null || Array.isArray(where)) {
    throw new ConditionError('A condition is an object.');
  }
  const keys = Object.keys(where);
  if (keys.includes('and') || keys.includes('or')) {
    if (keys.length !== 1) throw new ConditionError('`and` and `or` stand alone in a condition; nest the other fields inside.');
    const key = keys[0] as 'and' | 'or';
    const list = (where as Record<string, unknown>)[key];
    if (!Array.isArray(list) || list.length === 0) {
      throw new ConditionError(`\`${key}\` takes a list of one or more conditions.`);
    }
    for (const part of list) walkWhere(part as Where, onField);
    return;
  }
  for (const field of keys) {
    const value = (where as Record<string, unknown>)[field];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const ops = Object.keys(value);
      if (ops.length !== 1 || ops[0] !== 'in' || !Array.isArray((value as { in: unknown }).in)) {
        throw new ConditionError(`The condition on "${field}" is not supported: only equals and \`in\` are.`, field);
      }
      const list = (value as { in: unknown[] }).in;
      if (list.length > MAX_IN_VALUES) {
        throw new ConditionError(
          `The condition on "${field}" lists ${list.length} values; the limit is ${MAX_IN_VALUES}.`,
          field
        );
      }
      for (const v of list) checkColumnValue(field, checkScalar(field, v));
      onField(field, { in: list as Scalar[] });
    } else {
      checkColumnValue(field, checkScalar(field, value));
      onField(field, value as Scalar);
    }
  }
}

/** The condition in the form the ability matches rows with. */
export function toMongo(where: Where): Record<string, unknown> {
  const keys = Object.keys(where);
  if (keys[0] === 'and' || keys[0] === 'or') {
    const list = (where as Record<string, Where[]>)[keys[0]]!;
    return { [keys[0] === 'and' ? '$and' : '$or']: list.map(toMongo) };
  }
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(where as Record<string, Scalar | { in: Scalar[] }>)) {
    out[field] =
      typeof value === 'object' ? { $in: value.in.map(normaliseScalar) } : normaliseScalar(value);
  }
  return out;
}
