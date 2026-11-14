/**
 * The condition compiler: a condition (where.ts) to a parameterised SQL
 * fragment, ANDed by the store into every SELECT, UPDATE and DELETE. Equals,
 * `in` (at most 90 values), `and` and `or`; nothing else is accepted. It
 * touches no table: the store gives it the column a field is read from.
 */
import { ConditionError } from '../errors.ts';
import { isBuiltin, normaliseScalar, walkWhere, type Scalar, type Where } from './where.ts';

export interface Sql {
  sql: string;
  params: (string | number)[];
}

/** The SQL expression a field is read from, or null when a condition may not name it. */
export type ColumnOf = (field: string) => string | null;

export function compileWhere(where: Where, columnOf: ColumnOf): Sql {
  // Validate first, so an unsupported operator is named before any SQL is built.
  walkWhere(where, field => {
    if (columnOf(field) === null) {
      throw new ConditionError(`The condition names "${field}", which is neither a built-in column nor an indexed field.`, field);
    }
  });
  return build(where, columnOf);
}

function build(where: Where, columnOf: ColumnOf): Sql {
  const keys = Object.keys(where);
  if (keys[0] === 'and' || keys[0] === 'or') {
    const parts = (where as Record<string, Where[]>)[keys[0]]!.map(w => build(w, columnOf));
    return {
      sql: `(${parts.map(p => p.sql).join(keys[0] === 'and' ? ' AND ' : ' OR ')})`,
      params: parts.flatMap(p => p.params)
    };
  }
  const parts: Sql[] = [];
  for (const [field, value] of Object.entries(where as Record<string, Scalar | { in: Scalar[] }>)) {
    const column = columnOf(field)!;
    if (typeof value === 'object') {
      parts.push(
        value.in.length === 0
          ? { sql: '0', params: [] }
          : { sql: `${column} IN (${value.in.map(() => '?').join(', ')})`, params: value.in.map(normaliseScalar) }
      );
    } else {
      parts.push({ sql: `${column} = ?`, params: [normaliseScalar(value)] });
    }
  }
  if (parts.length === 0) return { sql: '1', params: [] };
  return { sql: parts.length === 1 ? parts[0]!.sql : `(${parts.map(p => p.sql).join(' AND ')})`, params: parts.flatMap(p => p.params) };
}

/** Grants are alternatives: a row matches when any grant's condition does. No grant, no rows (null). */
export function compileAny(conditions: (Where | undefined)[], columnOf: ColumnOf): Sql | null {
  if (conditions.length === 0) return null;
  if (conditions.some(c => c === undefined || Object.keys(c).length === 0)) return { sql: '1', params: [] };
  const parts = conditions.map(c => compileWhere(c!, columnOf));
  return { sql: `(${parts.map(p => p.sql).join(' OR ')})`, params: parts.flatMap(p => p.params) };
}

export { isBuiltin };
