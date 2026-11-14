/**
 * The precondition of a conditional update: equals, less than, greater than and
 * is-null on a named field, combined with `or` (fields of one object are ANDed).
 * Compiled to SQL and run in the same statement as the write, so it holds at the
 * moment of writing.
 */
import { ConditionError } from '../errors.ts';
import type { When } from '../store/types.ts';
import { isBuiltin } from './where.ts';
import type { Sql } from './compile.ts';

/** The SQL expression a field is read from, or null when the type has no such field. */
export type ReadField = (field: string) => string | null;

export function compileWhen(when: When, read: ReadField): Sql {
  if (typeof when !== 'object' || when === null || Array.isArray(when)) throw new ConditionError('A precondition is an object.');
  const keys = Object.keys(when);
  if (keys.length === 0) throw new ConditionError('A precondition names at least one field.');
  if (keys.includes('or')) {
    if (keys.length !== 1) throw new ConditionError('`or` stands alone in a precondition; nest the other fields inside.');
    const list = (when as { or: When[] }).or;
    if (!Array.isArray(list) || list.length === 0) throw new ConditionError('`or` takes a list of one or more preconditions.');
    const parts = list.map(w => compileWhen(w, read));
    return { sql: `(${parts.map(p => p.sql).join(' OR ')})`, params: parts.flatMap(p => p.params) };
  }
  const parts: Sql[] = [];
  for (const [field, compare] of Object.entries(when as Record<string, unknown>)) {
    const column = read(field);
    if (column === null) {
      throw new ConditionError(`The precondition names "${field}", which is neither a built-in column nor a field of the type.`, field);
    }
    if (typeof compare !== 'object' || compare === null || Array.isArray(compare) || Object.keys(compare).length !== 1) {
      throw new ConditionError(`The precondition on "${field}" is one of equals, lt, gt or isNull.`, field);
    }
    const [op, value] = Object.entries(compare)[0]!;
    switch (op) {
      case 'equals': {
        if (typeof value === 'boolean') parts.push({ sql: `${column} = ?`, params: [value ? 1 : 0] });
        else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
          if (isBuiltin(field) && typeof value !== 'string') throw new ConditionError(`The precondition on "${field}" must compare with a string.`, field);
          parts.push({ sql: `${column} = ?`, params: [value] });
        } else throw new ConditionError(`The precondition on "${field}" compares with a string, number or boolean; use isNull for null.`, field);
        break;
      }
      case 'lt':
      case 'gt':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new ConditionError(`The precondition on "${field}" compares with a number.`, field);
        parts.push({ sql: `${column} ${op === 'lt' ? '<' : '>'} ?`, params: [value] });
        break;
      case 'isNull':
        if (typeof value !== 'boolean') throw new ConditionError(`isNull on "${field}" takes true or false.`, field);
        parts.push({ sql: `${column} IS ${value ? '' : 'NOT '}NULL`, params: [] });
        break;
      default:
        throw new ConditionError(`The precondition on "${field}" uses "${op}"; only equals, lt, gt and isNull are supported.`, field);
    }
  }
  return { sql: parts.length === 1 ? parts[0]!.sql : `(${parts.map(p => p.sql).join(' AND ')})`, params: parts.flatMap(p => p.params) };
}
