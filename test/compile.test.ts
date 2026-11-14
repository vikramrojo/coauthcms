/** Task 2.3: the condition compiler, operator by operator. */
import { describe, expect, test } from 'bun:test';
import { compileAny, compileWhere, type ColumnOf } from '../src/core/access/compile.ts';
import { compileWhen } from '../src/core/access/when.ts';
import { ConditionError, MAX_IN_VALUES, type Where } from '../src/core/index.ts';

const columns = new Set(['id', 'owner_id', 'slug', 'status', 'parent_id', 'parent_status']);
const columnOf: ColumnOf = f => (columns.has(f) ? f : f === 'visibility' || f === 'retired' ? `f_${f}` : null);

describe('equals, in, and, or', () => {
  test('equals', () => {
    expect(compileWhere({ owner_id: 'A' }, columnOf)).toEqual({ sql: 'owner_id = ?', params: ['A'] });
  });

  test('equals on an indexed field reads its generated column; booleans are 1 and 0', () => {
    expect(compileWhere({ visibility: 'public' }, columnOf)).toEqual({ sql: 'f_visibility = ?', params: ['public'] });
    expect(compileWhere({ retired: false }, columnOf)).toEqual({ sql: 'f_retired = ?', params: [0] });
    expect(compileWhere({ retired: 1 }, columnOf)).toEqual({ sql: 'f_retired = ?', params: [1] });
  });

  test('several fields are ANDed', () => {
    expect(compileWhere({ status: 'published', visibility: 'public' }, columnOf)).toEqual({
      sql: '(status = ? AND f_visibility = ?)',
      params: ['published', 'public']
    });
  });

  test('in', () => {
    expect(compileWhere({ owner_id: { in: ['A', 'B', 'C'] } }, columnOf)).toEqual({ sql: 'owner_id IN (?, ?, ?)', params: ['A', 'B', 'C'] });
  });

  test('an empty in matches nothing', () => {
    expect(compileWhere({ owner_id: { in: [] } }, columnOf)).toEqual({ sql: '0', params: [] });
  });

  test('and, or and their nesting keep the parameters in order', () => {
    const where: Where = { or: [{ and: [{ status: 'published' }, { visibility: { in: ['public', 'link'] } }] }, { owner_id: 'A' }] };
    expect(compileWhere(where, columnOf)).toEqual({
      sql: '((status = ? AND f_visibility IN (?, ?)) OR owner_id = ?)',
      params: ['published', 'public', 'link', 'A']
    });
  });

  test('grants are alternatives; no grant is no rows and a grant with no condition is every row', () => {
    expect(compileAny([], columnOf)).toBeNull();
    expect(compileAny([undefined], columnOf)).toEqual({ sql: '1', params: [] });
    expect(compileAny([{ owner_id: 'A' }, undefined], columnOf)).toEqual({ sql: '1', params: [] });
    expect(compileAny([{ owner_id: 'A' }, { status: 'published' }], columnOf)).toEqual({
      sql: '(owner_id = ? OR status = ?)',
      params: ['A', 'published']
    });
  });
});

describe('what it refuses', () => {
  const refuses = (where: unknown, pattern: RegExp) => {
    const error = (() => {
      try {
        compileWhere(where as Where, columnOf);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConditionError);
    expect((error as Error).message).toMatch(pattern);
  };

  test('90 values are fine and 91 are refused, naming the limit and the field', () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
    expect(compileWhere({ owner_id: { in: values(MAX_IN_VALUES) } }, columnOf).params).toHaveLength(90);
    refuses({ owner_id: { in: values(91) } }, /"owner_id" lists 91 values; the limit is 90/);
  });

  test('a field that is neither built in nor indexed', () => {
    refuses({ color: 'red' }, /"color", which is neither a built-in column nor an indexed field/);
    refuses({ and: [{ status: 'x' }, { or: [{ color: 'red' }] }] }, /"color"/);
  });

  test('an operator outside equals, in, and, or', () => {
    refuses({ owner_id: { lt: 3 } }, /only equals and `in`/);
    refuses({ owner_id: { in: ['a'], gt: 1 } }, /only equals and `in`/);
    refuses({ owner_id: { $ne: 'a' } }, /only equals and `in`/);
    refuses({ not: { owner_id: 'a' } }, /not supported/);
  });

  test('null, undefined and other values', () => {
    refuses({ owner_id: null }, /compares with null/);
    refuses({ visibility: undefined }, /compares with undefined/);
    refuses({ visibility: { in: [null] } }, /compares with null/);
    refuses({ visibility: NaN }, /number/);
    refuses({ visibility: ['a'] }, /compares with object/);
  });

  test('and and or stand alone and take a non-empty list', () => {
    refuses({ and: [], status: 'x' }, /stand alone/);
    refuses({ or: [] }, /one or more/);
    refuses({ or: 'x' }, /one or more/);
  });

  test('a built-in column is compared as text', () => {
    refuses({ owner_id: 5 }, /must compare with a string/);
    refuses({ status: { in: [1] } }, /must compare with a string/);
  });
});

describe('the precondition of a conditional update', () => {
  const read = (f: string) => (columns.has(f) ? f : f === 'currentRevision' ? "json_extract(data, '$.currentRevision')" : null);

  test('equals, lt, gt, isNull and or', () => {
    expect(compileWhen({ currentRevision: { lt: 5 } }, read)).toEqual({ sql: "json_extract(data, '$.currentRevision') < ?", params: [5] });
    expect(compileWhen({ currentRevision: { gt: 5 } }, read).sql).toContain('> ?');
    expect(compileWhen({ currentRevision: { equals: 5 } }, read).params).toEqual([5]);
    expect(compileWhen({ currentRevision: { isNull: true } }, read).sql).toMatch(/IS NULL$/);
    expect(compileWhen({ currentRevision: { isNull: false } }, read).sql).toMatch(/IS NOT NULL$/);
    expect(compileWhen({ or: [{ currentRevision: { isNull: true } }, { currentRevision: { lt: 5 } }] }, read)).toEqual({
      sql: "(json_extract(data, '$.currentRevision') IS NULL OR json_extract(data, '$.currentRevision') < ?)",
      params: [5]
    });
  });

  test('refuses what it does not know', () => {
    expect(() => compileWhen({ ghost: { lt: 1 } }, read)).toThrow(/"ghost"/);
    expect(() => compileWhen({ currentRevision: { lte: 1 } as never }, read)).toThrow(/only equals, lt, gt and isNull/);
    expect(() => compileWhen({ currentRevision: { lt: '1' as never } }, read)).toThrow(/number/);
    expect(() => compileWhen({ currentRevision: { equals: null as never } }, read)).toThrow(/isNull/);
    expect(() => compileWhen({}, read)).toThrow(/at least one/);
  });
});
