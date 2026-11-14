/** Task 2.1: content types with ownership, indexing, access, mirrors, system fields and hooks. */
import { describe, expect, test } from 'bun:test';
import { ConfigError, contentType, createCms, field } from '../src/core/index.ts';
import { createDb } from './support.ts';
import { score } from './types.check.ts';

describe('contentType', () => {
  test('an owned, indexed type with an access function and a system field', () => {
    expect(score).toMatchObject({ id: 'score', owned: true, indexed: ['visibility'], uniqueSlug: false, mirrors: [] });
    expect(score.fieldMeta.currentRevision).toMatchObject({ system: true, fieldType: 'number' });
    expect(score.fieldMeta.title).toMatchObject({ required: true, system: false });
    expect(typeof score.access).toBe('function');
  });

  test('an owned type with no access function fails createCms, naming the type', async () => {
    const orphan = contentType({ id: 'orphan', name: 'O', displayField: 'title', owned: true, fields: { title: field.text('T') } });
    const t = await createDb();
    expect(() => createCms({ db: t.db, types: [orphan] })).toThrow(/Type "orphan" is owned and has no access function/);
    await t.dispose();
  });

  test('a name that collides with a built-in column, an unknown indexed field and mirrors without a parent are refused', () => {
    const make = (over: Record<string, unknown>, fields: Record<string, any> = { title: field.text('T') }) =>
      () => contentType({ id: 'x', name: 'X', displayField: 'title', fields, ...over });
    expect(make({}, { title: field.text('T'), slug: field.text('S') })).toThrow(/"slug".*built-in/);
    expect(make({}, { title: field.text('T'), owner_id: field.text('O') })).toThrow(/"owner_id"/);
    expect(make({ indexed: ['nope'] })).toThrow(/indexes "nope"/);
    expect(make({ mirrors: ['status'] })).toThrow(/names no parent/);
    expect(make({}, { 'bad name': field.text('B'), title: field.text('T') })).toThrow(/"bad name"/);
  });

  test('a parent that is not defined fails createCms', async () => {
    const child = contentType({ id: 'child', name: 'C', displayField: 'title', parent: 'ghost', fields: { title: field.text('T') } });
    const t = await createDb();
    expect(() => createCms({ db: t.db, types: [child] })).toThrow(/parent type "ghost"/);
    await t.dispose();
  });

  test('a field grant naming a field the type lacks fails startup', async () => {
    const bad = contentType({
      id: 'bad',
      name: 'B',
      displayField: 'title',
      fields: { title: field.text('T') },
      access: (_p, { can }) => can('update', { fields: ['ghost'] })
    });
    const t = await createDb();
    expect(() => createCms({ db: t.db, types: [bad] })).toThrow(ConfigError);
    await t.dispose();
  });

  test('groups carry their fields', () => {
    const grouped = contentType({
      id: 'g',
      name: 'G',
      displayField: 'a',
      fields: [
        { groupId: 'one', name: 'One', fields: { a: field.text('A') } },
        { groupId: 'two', name: 'Two', fields: { b: field.number('B') } }
      ]
    });
    expect(Object.keys(grouped.fields)).toEqual(['a', 'b']);
    expect(grouped.groups).toHaveLength(2);
  });
});

describe('field validation', () => {
  test('each field kind has a schema that accepts its value and refuses another', async () => {
    const { Validator } = await import('@cfworker/json-schema');
    const ok = (f: { schema: any }, v: unknown) => new Validator(f.schema, '7').validate(v).valid;
    expect(ok(field.text('x'), 'a')).toBe(true);
    expect(ok(field.text('x'), 1)).toBe(false);
    expect(ok(field.text('x').max(2), 'abc')).toBe(false);
    expect(ok(field.number('x').min(1), 0)).toBe(false);
    expect(ok(field.boolean('x'), true)).toBe(true);
    expect(ok(field.date('x'), '2026-11-14T10:00:00Z')).toBe(true);
    expect(ok(field.date('x'), 'yesterday')).toBe(false);
    expect(ok(field.url('x'), 'https://sinfon.app')).toBe(true);
    expect(ok(field.email('x'), 'nope')).toBe(false);
    expect(ok(field.select('x', { options: ['a', 'b'] }), 'c')).toBe(false);
    expect(ok(field.refs('y', 'x'), ['1', '2'])).toBe(true);
    expect(ok(field.files('x'), [{ name: 'a', size: 1, url: '/a' }])).toBe(true);
    expect(ok(field.files('x'), [{ name: 'a' }])).toBe(false);
    expect(ok(field.json('x'), { any: ['thing'] })).toBe(true);
  });
});
