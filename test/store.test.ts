/** Tasks 3.3 to 3.8: the store answers every read and write for a named caller. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ConfigError, Conflict, Forbidden, TooManyChildren, ValidationError, WriteRefused, contentType, field
} from '../src/core/index.ts';
import { admin, anonymous, composer, createWorld, lapsed, page, score, system, type Composer, type World } from './sample.ts';

let w: World;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(() => w.dispose());

const as = (principal: Parameters<World['cms']['content']['as']>[0]) => w.cms.content.as(principal);
const newScore = (owner: string, over: Record<string, unknown> = {}) =>
  as(system('test')).create('score', { owner_id: owner, slug: `slug-${Math.random().toString(36).slice(2, 8)}`, title: 'T', visibility: 'link', rights: 'original', retired: 0, ...over });

describe('two owners', () => {
  test('each sees only their own, by list and by id', async () => {
    const a = await newScore('A', { title: 'A1' });
    const b = await newScore('B', { title: 'B1' });
    expect((await as(composer('A')).list('score')).map(e => e.id)).toEqual([a.id]);
    expect((await as(composer('B')).list('score')).map(e => e.id)).toEqual([b.id]);
    expect((await as(composer('A')).get('score', a.id))?.data.title).toBe('A1');
  });

  test("a read of another owner's row answers null, as for an id that does not exist", async () => {
    const b = await newScore('B');
    const mine = as(composer('A'));
    expect(await mine.get('score', b.id)).toBeNull();
    expect(await mine.get('score', 'no-such-id')).toBeNull();
    expect(await mine.getBySlug('score', b.slug!)).toBeNull();
  });

  test('a caller of several owners sees all of theirs and no others', async () => {
    for (const o of ['A', 'B', 'C', 'D']) await newScore(o);
    const owners = (await as(composer('A', 'B', 'C')).list('score')).map(e => e.owner_id).sort();
    expect(owners).toEqual(['A', 'B', 'C']);
  });

  test('a write to another owner\'s row is forbidden, naming the operation, and changes nothing', async () => {
    const b = await newScore('B', { title: 'Keep' });
    const error = await as(composer('A')).update('score', b.id, { title: 'Taken' }).catch(e => e);
    expect(error).toBeInstanceOf(Forbidden);
    expect(error).toMatchObject({ operation: 'update', type: 'score' });
    expect(error.message).toContain('update');
    await expect(as(composer('A')).remove('score', b.id)).rejects.toMatchObject({ operation: 'delete' });
    expect((await as(system('test')).get('score', b.id))?.data.title).toBe('Keep');
  });

  test('a write to a row that does not exist is refused the same way', async () => {
    await expect(as(composer('A')).update('score', 'nope', { title: 'x' })).rejects.toBeInstanceOf(Forbidden);
    await expect(as(composer('A')).remove('score', 'nope')).rejects.toBeInstanceOf(Forbidden);
  });

  test('create is checked against the new row: an owner may not create for another', async () => {
    await expect(as(composer('A')).create('score', { owner_id: 'B', title: 'x' })).rejects.toMatchObject({ operation: 'create' });
    const own = await as(composer('A')).create('score', { owner_id: 'A', title: 'mine', slug: 'mine-1' });
    expect(own).toMatchObject({ owner_id: 'A', status: 'draft', slug: 'mine-1' });
  });

  test('what a composer creates they can list: a default fills a system field the rules read', async () => {
    const own = await as(composer('A')).create('score', { owner_id: 'A', title: 'mine', slug: 'mine-2' });
    expect(own.data.retired).toBe(0);
    expect((await as(composer('A')).list('score')).map(e => e.id)).toEqual([own.id]);
    expect((await as(composer('A')).get('score', own.id))?.id).toBe(own.id);
    // A default does not let the creator write the field: naming it is still refused.
    await expect(as(composer('A')).create('score', { owner_id: 'A', title: 'x', retired: 1 })).rejects.toMatchObject({ field: 'retired' });
  });

  test('a lapsed composer reads and cannot create', async () => {
    const a = await newScore('A');
    expect((await as(lapsed('A')).list('score')).map(e => e.id)).toEqual([a.id]);
    await expect(as(lapsed('A')).create('score', { owner_id: 'A', title: 'x' })).rejects.toMatchObject({ operation: 'create' });
  });

  test('an owned entry is created with an owner', async () => {
    await expect(as(system('test')).create('score', { title: 'x' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('default deny', () => {
  test('a type with no rule for the caller yields no rows', async () => {
    await newScore('A');
    expect(await as(anonymous).list('score')).toEqual([]);
    expect(await as(system('test')).list('page')).toEqual([]);
  });

  test('an admin granted read only is refused a delete', async () => {
    const hidden = contentType({
      id: 'note',
      name: 'Notes',
      displayField: 'title',
      fields: { title: field.text('Title') },
      access: (p, { can }) => {
        if (p.kind === 'admin') can('read');
        if (p.kind === 'system') can('create');
      }
    });
    const world = await createWorld([hidden]);
    const made = await world.cms.content.as(system('x')).create('note', { title: 'n' });
    expect((await world.cms.content.as(admin()).list('note')).map(e => e.id)).toEqual([made.id]);
    await expect(world.cms.content.as(admin()).remove('note', made.id)).rejects.toMatchObject({ operation: 'delete' });
    await expect(world.cms.content.as(admin()).update('note', made.id, { title: 'x' })).rejects.toBeInstanceOf(Forbidden);
    await expect(world.cms.content.as(admin()).publish('note', made.id)).rejects.toBeInstanceOf(Forbidden);
    await world.dispose();
  });

  test('the system caller has no power its rules did not give: page grants it nothing', async () => {
    await expect(as(system('job')).create('page', { title: 'x' })).rejects.toBeInstanceOf(Forbidden);
  });

  test('a type that is not defined is a configuration error, not an empty list', async () => {
    await expect(as(anonymous).list('ghost')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('field rules (3.4)', () => {
  test('an owner may write the fields the grant lists', async () => {
    const mine = await newScore('A');
    const result = await as(composer('A')).update('score', mine.id, { title: 'New', visibility: 'public' });
    expect(result).toMatchObject({ applied: true, entry: { data: { title: 'New', visibility: 'public' } } });
  });

  test('a write to a system field is refused whole, naming the field, and nothing changes', async () => {
    const mine = await newScore('A', { title: 'Same' });
    const error = await as(composer('A')).update('score', mine.id, { title: 'Changed', currentRevision: 9 }).catch(e => e);
    expect(error).toBeInstanceOf(Forbidden);
    expect(error).toMatchObject({ operation: 'update', field: 'currentRevision' });
    expect((await as(system('t')).get('score', mine.id))?.data).toMatchObject({ title: 'Same' });
    expect((await as(system('t')).get('score', mine.id))?.data.currentRevision).toBeUndefined();
  });

  test('a system caller whose rule lists the field writes it', async () => {
    const mine = await newScore('A');
    const result = await as(system('commit')).update('score', mine.id, { currentRevision: 3 });
    expect(result).toMatchObject({ applied: true, entry: { data: { currentRevision: 3 } } });
  });

  test('owner_id, slug and status are not writable by an ordinary update', async () => {
    const mine = await newScore('A');
    for (const key of ['owner_id', 'slug'] as const) {
      await expect(as(composer('A')).update('score', mine.id, { [key]: 'x' })).rejects.toMatchObject({ field: key });
    }
    await expect(as(composer('A')).update('score', mine.id, { status: 'published' })).rejects.toMatchObject({ field: 'status' });
    // A rule that lists owner_id lets the system caller re-own an entry.
    const moved = await as(system('merge')).update('score', mine.id, { owner_id: 'B' });
    expect(moved).toMatchObject({ applied: true, entry: { owner_id: 'B' } });
    await expect(as(system('merge')).update('score', mine.id, { slug: 'y' })).rejects.toMatchObject({ field: 'slug' });
  });

  test('a field the type does not have is a validation error', async () => {
    const mine = await newScore('A');
    await expect(as(composer('A')).update('score', mine.id, { nope: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(as(composer('A')).update('score', mine.id, { title: 5 })).rejects.toBeInstanceOf(ValidationError);
  });

  test('create: a required field, a bad value and a system field supplied by the wrong caller', async () => {
    await expect(as(composer('A')).create('score', { owner_id: 'A' })).rejects.toBeInstanceOf(ValidationError);
    await expect(as(composer('A')).create('score', { owner_id: 'A', title: 'x', currentRevision: 1 })).rejects.toMatchObject({ field: 'currentRevision' });
    await expect(as(system('t')).create('score', { owner_id: 'A', title: 'x'.repeat(201) })).rejects.toBeInstanceOf(ValidationError);
  });

  test('null clears an optional field', async () => {
    const mine = await newScore('A', { composer: 'Ada' });
    const result = await as(composer('A')).update('score', mine.id, { composer: null });
    expect(result).toMatchObject({ applied: true, entry: { data: { composer: null } } });
  });

  test('an update leaves the other fields as they were', async () => {
    const mine = await newScore('A', { composer: 'Ada', rights: 'original' });
    await as(composer('A')).update('score', mine.id, { title: 'Changed' });
    expect((await as(composer('A')).get('score', mine.id))?.data).toMatchObject({ title: 'Changed', composer: 'Ada', rights: 'original', visibility: 'link' });
  });
});

describe('slug (3.5)', () => {
  test('an unlisted entry is out of an anonymous list and found by its slug', async () => {
    const hidden = await newScore('A', { slug: 'hidden-1', visibility: 'link' });
    const shown = await newScore('A', { slug: 'shown-1', visibility: 'public' });
    await as(admin()).publish('score', hidden.id);
    await as(admin()).publish('score', shown.id);
    expect((await as(anonymous).list('score')).map(e => e.id)).toEqual([shown.id]);
    expect((await as(anonymous).getBySlug('score', 'hidden-1'))?.id).toBe(hidden.id);
    expect(await as(anonymous).get('score', hidden.id)).toBeNull();
  });

  test('a draft is not found by slug, and a slug is unique within the type', async () => {
    const draft = await newScore('A', { slug: 'draft-1' });
    expect(await as(anonymous).getBySlug('score', 'draft-1')).toBeNull();
    expect((await as(system('t')).getBySlug('score', 'draft-1'))?.id).toBe(draft.id);
    await expect(newScore('B', { slug: 'draft-1' })).rejects.toBeInstanceOf(Conflict);
  });
});

describe('conditional update (3.6)', () => {
  const advance = (id: string, n: number) =>
    as(system('commit')).update('score', id, { currentRevision: n }, { when: { or: [{ currentRevision: { isNull: true } }, { currentRevision: { lt: n } }] } });

  test('4 then 5 and 5 then 4 both end at 5, and the late one reports not applied', async () => {
    const one = await newScore('A');
    expect(await advance(one.id, 4)).toMatchObject({ applied: true });
    expect(await advance(one.id, 5)).toMatchObject({ applied: true });
    expect((await as(system('t')).get('score', one.id))?.data.currentRevision).toBe(5);

    const two = await newScore('A');
    expect(await advance(two.id, 5)).toMatchObject({ applied: true });
    expect(await advance(two.id, 4)).toEqual({ applied: false, reason: 'precondition' });
    expect((await as(system('t')).get('score', two.id))?.data.currentRevision).toBe(5);
  });

  test('two at once leave the higher', async () => {
    const one = await newScore('A');
    const results = await Promise.all([advance(one.id, 4), advance(one.id, 5), advance(one.id, 3)]);
    expect(results.filter(r => r.applied).length).toBeGreaterThanOrEqual(1);
    expect((await as(system('t')).get('score', one.id))?.data.currentRevision).toBe(5);
  });

  test('equals, greater than and is-null, and a built-in column', async () => {
    const one = await newScore('A');
    const set = (n: number, when: Parameters<typeof advance>[0] extends string ? any : never) => as(system('c')).update('score', one.id, { currentRevision: n }, { when });
    expect(await set(1, { currentRevision: { gt: 0 } })).toEqual({ applied: false, reason: 'precondition' });
    expect(await set(1, { currentRevision: { isNull: true } })).toMatchObject({ applied: true });
    expect(await set(2, { currentRevision: { equals: 1 } })).toMatchObject({ applied: true });
    expect(await set(3, { currentRevision: { equals: 1 } })).toEqual({ applied: false, reason: 'precondition' });
    expect(await set(3, { currentRevision: { gt: 1 }, status: { equals: 'draft' } })).toMatchObject({ applied: true });
    expect(await set(4, { currentRevision: { isNull: false }, status: { equals: 'published' } })).toEqual({ applied: false, reason: 'precondition' });
  });

  test('the access check still applies: an owner may not use a precondition to reach a system field or another owner\'s row', async () => {
    const b = await newScore('B');
    await expect(as(composer('A')).update('score', b.id, { title: 'x' }, { when: { currentRevision: { isNull: true } } })).rejects.toBeInstanceOf(Forbidden);
  });

  test('a precondition on a field the type does not have is refused', async () => {
    const one = await newScore('A');
    await expect(as(system('c')).update('score', one.id, { currentRevision: 1 }, { when: { ghost: { lt: 1 } } })).rejects.toThrow(/ghost/);
  });
});

describe('mirrored status (3.7)', () => {
  const notebook = contentType({
    id: 'notebook',
    name: 'Notebooks',
    displayField: 'title',
    owned: true,
    fields: { title: field.text('Title') },
    access: (p: any, { can }) => {
      if (p.kind === 'admin') can(['create', 'read', 'publish']);
    }
  });
  const note = contentType({
    id: 'note',
    name: 'Notes',
    displayField: 'text',
    owned: true,
    parent: 'notebook',
    mirrors: ['status'],
    fields: { text: field.text('Text') },
    access: (p: any, { can }) => {
      can('read', { where: { parent_status: 'published' } });
      if (p.kind === 'admin') can(['create', 'read']);
    }
  });

  test('a parent with three children makes them anonymously readable in one step', async () => {
    const world = await createWorld([notebook, note]);
    const content = world.cms.content.as(admin());
    const parent = await content.create('notebook', { owner_id: 'A', title: 'N' });
    for (const text of ['one', 'two', 'three']) await content.create('note', { owner_id: 'A', parent_id: parent.id, text });
    const anon = world.cms.content.as(anonymous);
    expect(await anon.list('note')).toEqual([]);
    await content.publish('notebook', parent.id);
    expect((await anon.list('note')).map(e => e.data.text).sort()).toEqual(['one', 'three', 'two']);
    expect((await anon.list('note'))[0]).toMatchObject({ parent_status: 'published', parent_id: parent.id });
    await content.unpublish('notebook', parent.id);
    expect(await anon.list('note')).toEqual([]);
    await world.dispose();
  });

  test('a child created under a published parent starts readable', async () => {
    const world = await createWorld([notebook, note]);
    const content = world.cms.content.as(admin());
    const parent = await content.create('notebook', { owner_id: 'A', title: 'N' });
    await content.publish('notebook', parent.id);
    const child = await content.create('note', { owner_id: 'A', parent_id: parent.id, text: 'late' });
    expect(child.parent_status).toBe('published');
    expect((await world.cms.content.as(anonymous).list('note')).map(e => e.id)).toEqual([child.id]);
    await world.dispose();
  });

  test('a parent over the cap is refused with nothing changed', async () => {
    const world = await createWorld([notebook, note], { maxMirrorChildren: 2 });
    const content = world.cms.content.as(admin());
    const parent = await content.create('notebook', { owner_id: 'A', title: 'N' });
    for (const text of ['one', 'two', 'three']) await content.create('note', { owner_id: 'A', parent_id: parent.id, text });
    const error = await content.publish('notebook', parent.id).catch(e => e);
    expect(error).toBeInstanceOf(TooManyChildren);
    expect(error.message).toContain('2');
    expect((await content.get('notebook', parent.id))?.status).toBe('draft');
    expect(await world.cms.content.as(anonymous).list('note')).toEqual([]);
    await world.dispose();
  });

  test('a publish that a rule refuses copies nothing to the children', async () => {
    const world = await createWorld([notebook, note]);
    const content = world.cms.content.as(admin());
    const parent = await content.create('notebook', { owner_id: 'A', title: 'N' });
    await content.create('note', { owner_id: 'A', parent_id: parent.id, text: 'x' });
    await expect(world.cms.content.as(anonymous).publish('notebook', parent.id)).rejects.toBeInstanceOf(Forbidden);
    expect(await world.cms.content.as(anonymous).list('note')).toEqual([]);
    await world.dispose();
  });
});

describe('publishing is its own operation', () => {
  test('may edit, may not publish', async () => {
    const mine = await newScore('A');
    await expect(as(composer('A')).publish('score', mine.id)).rejects.toMatchObject({ operation: 'publish' });
    expect((await as(composer('A')).get('score', mine.id))?.status).toBe('draft');
  });

  test('publish and unpublish move the status, and `set` writes only the fields the grant lists, in the same statement', async () => {
    const mine = await newScore('A');
    expect(await as(system('commit')).publish('score', mine.id)).toMatchObject({ applied: true, entry: { status: 'published' } });
    const retired = await as(system('purge')).unpublish('score', mine.id, { set: { retired: 1, unpublishedAt: '2026-11-14T00:00:00Z' } });
    expect(retired).toMatchObject({ applied: true, entry: { status: 'draft', data: { retired: 1, unpublishedAt: '2026-11-14T00:00:00Z' } } });
    await expect(as(system('purge')).unpublish('score', mine.id, { set: { title: 'x' } })).rejects.toMatchObject({ field: 'title' });
    await expect(as(admin()).unpublish('score', mine.id, { set: { retired: 1 } })).rejects.toMatchObject({ field: 'retired' });
    // The owner no longer sees it: the rule keys on retired.
    expect(await as(composer('A')).get('score', mine.id)).toBeNull();
  });
});

describe('hooks (3.8)', () => {
  const guarded = (log: string[]) =>
    contentType({
      id: 'memo',
      name: 'Memos',
      displayField: 'text',
      owned: true,
      fields: { text: field.text('Text') },
      access: (p: Composer | { kind: string }, { can }) => {
        if (p.kind === 'composer') can(['create', 'read', 'update', 'delete'], { where: { owner_id: { in: (p as Composer).ownerIds } } });
      },
      beforeWrite: async ctx => {
        log.push(`before ${ctx.operation}`);
        if (ctx.input.text === 'forbidden word') ctx.refuse('That word is not allowed.');
        // A hook calls the store as the same caller, so it cannot read what the caller may not.
        const others = await ctx.content.list('memo');
        log.push(`sees ${others.length}`);
      },
      afterWrite: ctx => {
        log.push(`after ${ctx.operation} ${ctx.entry?.data.text ?? '-'}`);
      }
    });

  test("a before-write hook's refusal stores nothing and returns its message", async () => {
    const log: string[] = [];
    const world = await createWorld([guarded(log)]);
    const mine = world.cms.content.as(composer('A'));
    const error = await mine.create('memo', { owner_id: 'A', text: 'forbidden word' }).catch(e => e);
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe('That word is not allowed.');
    expect(await mine.list('memo')).toEqual([]);
    expect(log).toEqual(['before create']);
    await world.dispose();
  });

  test('a hook that calls the store does so as the same caller, and after-hooks run once the write is stored', async () => {
    const log: string[] = [];
    const world = await createWorld([guarded(log)]);
    const system1 = world.cms.content.as(system('seed'));
    // The system caller has no rule on memo, so it cannot write; a composer of B writes one the composer of A must not see in a hook.
    await expect(system1.create('memo', { owner_id: 'B', text: 'x' })).rejects.toBeInstanceOf(Forbidden);
    await world.cms.content.as(composer('B')).create('memo', { owner_id: 'B', text: 'b1' });
    log.length = 0;
    await world.cms.content.as(composer('A')).create('memo', { owner_id: 'A', text: 'a1' });
    expect(log).toEqual(['before create', 'sees 0', 'after create a1']);
    await world.dispose();
  });

  test('a hook does not run for a write the rules refuse', async () => {
    const log: string[] = [];
    const world = await createWorld([guarded(log)]);
    await expect(world.cms.content.as(anonymous).create('memo', { text: 'x' })).rejects.toBeInstanceOf(Forbidden);
    expect(log).toEqual([]);
    await world.dispose();
  });
});

describe('startup checks', () => {
  test('an owned type with no access function fails createCms, naming the type', () => {
    const bad = contentType({ id: 'orphan', name: 'O', displayField: 'title', owned: true, fields: { title: field.text('T') } });
    expect(() => createWorld([bad])).toThrow(/orphan/);
  });

  test('a condition on a field that is not indexed fails, naming the type and the field', async () => {
    const bad = contentType({
      id: 'thing',
      name: 'T',
      displayField: 'title',
      fields: { title: field.text('T'), color: field.text('C') },
      access: (_p, { can }) => can('read', { where: { color: 'red' } })
    });
    const error = await createWorld([bad]).catch(e => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ type: 'thing', field: 'color' });
    expect(error.message).toContain('thing');
    expect(error.message).toContain('color');
  });

  test('page is a plain type with an admin: its anonymous reads see published pages only', async () => {
    const made = await as(admin()).create('page', { title: 'About', slug: 'about' });
    expect(await as(anonymous).list('page')).toEqual([]);
    await as(admin()).publish('page', made.id);
    expect((await as(anonymous).getBySlug('page', 'about'))?.data.title).toBe('About');
  });
});
