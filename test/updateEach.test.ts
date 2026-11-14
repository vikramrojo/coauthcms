/** `updateEach`: several entries of one type updated in one write, all or nothing (spec content-store, "Several entries can be updated in one write"). */
import { afterEach, describe, expect, test } from 'bun:test';
import { Forbidden, TooManyEntries, ValidationError, WriteRefused, contentType, field } from '../src/core/index.ts';
import { composer, createWorld, score, system, page, type Composer, type World } from './sample.ts';

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length > 0) await worlds.pop()!.dispose();
});
async function world(...args: Parameters<typeof createWorld>): Promise<World> {
  const w = await createWorld(...args);
  worlds.push(w);
  return w;
}

/** The batches a world's store has run since now; `before` runs just ahead of each (to play a concurrent writer). */
function watch(w: World, before?: () => Promise<void>) {
  w.count.reset();
  w.count.beforeBatch = before;
  return w.count.batches;
}

const make = async (w: World, owner: string, n: number, over: Record<string, unknown> = {}) => {
  const api = w.cms.content.as(system('seed'));
  const made = [];
  for (let i = 0; i < n; i++) {
    made.push(await api.create('score', { owner_id: owner, slug: `s-${owner}-${made.length}-${Math.random().toString(36).slice(2, 7)}`, title: `T${i}`, visibility: 'link', rights: 'original', retired: 0, ...over }));
  }
  return made;
};
const titles = async (w: World, owner: string) => (await w.cms.content.as(composer(owner)).list('score', { orderBy: 'created_at', direction: 'asc', limit: 1000 })).map(e => e.data.title);

describe('updateEach', () => {
  test('writes every row in one batch and returns the entries in the order given', async () => {
    const w = await world();
    const rows = await make(w, 'A', 5);
    const batches = watch(w);
    const mine = w.cms.content.as(composer('A'));
    const changes = [...rows].reverse().map((r, i) => ({ id: r.id, patch: { title: `New ${i}` } }));
    const result = await mine.updateEach('score', changes);
    expect(result.map(e => e.data.title)).toEqual(['New 0', 'New 1', 'New 2', 'New 3', 'New 4']);
    expect(result.map(e => e.id)).toEqual(changes.map(c => c.id));
    // one batch: a guard for the one chunk of ids, then one UPDATE per row
    expect(batches).toEqual([1 + 5]);
    expect((await mine.get('score', rows[0]!.id))?.data.title).toBe('New 4');
  });

  test('more than one chunk of ids is read in chunks and still written in one batch', async () => {
    const w = await world();
    const rows = await make(w, 'A', 100);
    const batches = watch(w);
    const result = await w.cms.content.as(composer('A')).updateEach('score', rows.map((r, i) => ({ id: r.id, patch: { title: `n${i}` } })));
    expect(result).toHaveLength(100);
    expect(result.map(e => e.data.title)).toEqual(rows.map((_, i) => `n${i}`));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBeGreaterThan(100);
  });

  test("another owner's row in the list fails the call and changes nothing, as does a row that does not exist", async () => {
    const w = await world();
    const mine = await make(w, 'A', 3);
    const [theirs] = await make(w, 'B', 1);
    const batches = watch(w);
    const api = w.cms.content.as(composer('A'));
    const error = await api.updateEach('score', [{ id: mine[0]!.id, patch: { title: 'X' } }, { id: theirs!.id, patch: { title: 'X' } }, { id: mine[1]!.id, patch: { title: 'X' } }]).catch(e => e);
    expect(error).toBeInstanceOf(Forbidden);
    expect(error).toMatchObject({ operation: 'update', type: 'score' });
    await expect(api.updateEach('score', [{ id: mine[0]!.id, patch: { title: 'X' } }, { id: 'nope', patch: { title: 'X' } }])).rejects.toBeInstanceOf(Forbidden);
    expect(await titles(w, 'A')).toEqual(['T0', 'T1', 'T2']);
    expect((await w.cms.content.as(system('x')).get('score', theirs!.id))?.data.title).toBe('T0');
    expect(batches).toEqual([]);
  });

  test('a row that moves out of reach between the read and the write fails the call and rolls the rest back', async () => {
    const w = await world();
    const rows = await make(w, 'A', 4);
    // a concurrent writer takes the last row away just before the batch runs
    const batches = watch(w, async () => {
      await w.t.db.prepare("UPDATE entries SET owner_id = 'B' WHERE id = ?").bind(rows[3]!.id).run();
    });
    const error = await w.cms.content.as(composer('A')).updateEach('score', rows.map(r => ({ id: r.id, patch: { title: 'X' } }))).catch(e => e);
    expect(error).toBeInstanceOf(Forbidden);
    expect(batches).toHaveLength(1);
    const left = (await w.t.db.prepare("SELECT json_extract(data, '$.title') AS t FROM entries WHERE content_type = 'score' ORDER BY created_at, id").all<{ t: string }>()).results.map(r => r.t);
    expect(left).toEqual(['T0', 'T1', 'T2', 'T3']);
  });

  test('a field the caller may not write, an unknown field and a bad value each fail the call and change nothing', async () => {
    const w = await world();
    const rows = await make(w, 'A', 3);
    const api = w.cms.content.as(composer('A'));
    const batches = watch(w);
    const ok = (i: number) => ({ id: rows[i]!.id, patch: { title: 'X' } });
    const forbidden = await api.updateEach('score', [ok(0), { id: rows[1]!.id, patch: { title: 'X', currentRevision: 9 } }, ok(2)]).catch(e => e);
    expect(forbidden).toBeInstanceOf(Forbidden);
    expect(forbidden).toMatchObject({ operation: 'update', field: 'currentRevision' });
    for (const key of ['owner_id', 'slug', 'status']) {
      await expect(api.updateEach('score', [ok(0), { id: rows[1]!.id, patch: { [key]: 'x' } }])).rejects.toMatchObject({ name: 'Forbidden', field: key });
    }
    await expect(api.updateEach('score', [ok(0), { id: rows[1]!.id, patch: { nope: 1 } }])).rejects.toBeInstanceOf(ValidationError);
    await expect(api.updateEach('score', [ok(0), { id: rows[1]!.id, patch: { title: 5 } }])).rejects.toBeInstanceOf(ValidationError);
    expect(await titles(w, 'A')).toEqual(['T0', 'T1', 'T2']);
    expect(batches).toEqual([]);
  });

  test('a system grant that lists a protected column may write it to every row', async () => {
    const w = await world();
    const rows = await make(w, 'A', 3);
    const result = await w.cms.content.as(system('merge')).updateEach('score', rows.map(r => ({ id: r.id, patch: { owner_id: 'B' } })));
    expect(result.map(e => e.owner_id)).toEqual(['B', 'B', 'B']);
  });

  const memo = (log: string[]) =>
    contentType({
      id: 'memo',
      name: 'Memos',
      displayField: 'text',
      owned: true,
      fields: { text: field.text('Text') },
      access: (p: Composer | { kind: string }, { can }) => {
        if (p.kind === 'composer') can(['create', 'read', 'update', 'delete'], { where: { owner_id: { in: (p as Composer).ownerIds } } });
      },
      beforeWrite: ctx => {
        log.push(`before ${ctx.operation} ${String(ctx.input.text)}`);
        if (ctx.input.text === 'forbidden word') ctx.refuse('That word is not allowed.');
      },
      afterWrite: ctx => {
        log.push(`after ${ctx.operation} ${ctx.entry?.data.text ?? '-'}`);
      }
    });

  test("a before-write hook's refusal on any row fails the call and changes nothing; hooks run per row, after-hooks once the write is stored", async () => {
    const log: string[] = [];
    const w = await world([memo(log)]);
    const api = w.cms.content.as(composer('A'));
    const made = [];
    for (const text of ['a', 'b', 'c']) made.push(await api.create('memo', { owner_id: 'A', text }));
    log.length = 0;
    const error = await api.updateEach('memo', [{ id: made[0]!.id, patch: { text: 'x' } }, { id: made[1]!.id, patch: { text: 'forbidden word' } }, { id: made[2]!.id, patch: { text: 'z' } }]).catch(e => e);
    expect(error).toBeInstanceOf(WriteRefused);
    expect(error.message).toBe('That word is not allowed.');
    expect((await api.list('memo', { orderBy: 'created_at', direction: 'asc' })).map(e => e.data.text)).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['before update x', 'before update forbidden word']);

    log.length = 0;
    await api.updateEach('memo', [{ id: made[0]!.id, patch: { text: 'x' } }, { id: made[2]!.id, patch: { text: 'z' } }]);
    expect(log).toEqual(['before update x', 'before update z', 'after update x', 'after update z']);
  });

  test('more rows than the host allows (500 unless set) are refused naming the limit, and nothing changes', async () => {
    const w = await world([score, page], { maxUpdateEach: 3 });
    const rows = await make(w, 'A', 4);
    const batches = watch(w);
    const api = w.cms.content.as(composer('A'));
    const error = await api.updateEach('score', rows.map(r => ({ id: r.id, patch: { title: 'X' } }))).catch(e => e);
    expect(error).toBeInstanceOf(TooManyEntries);
    expect(error.message).toContain('limit is 3');
    expect(await titles(w, 'A')).toEqual(['T0', 'T1', 'T2', 'T3']);
    expect(batches).toEqual([]);
    expect(await api.updateEach('score', rows.slice(0, 3).map(r => ({ id: r.id, patch: { title: 'ok' } })))).toHaveLength(3);
  });

  test('the default limit is 500', async () => {
    const w = await world();
    const ids = Array.from({ length: 501 }, (_, i) => ({ id: `x${i}`, patch: { title: 'X' } }));
    await expect(w.cms.content.as(composer('A')).updateEach('score', ids)).rejects.toMatchObject({ name: 'TooManyEntries', limit: 500 });
  });

  test('an empty list writes nothing, a repeated id is refused, a caller with no update grant is Forbidden', async () => {
    const w = await world();
    const [row] = await make(w, 'A', 1);
    const api = w.cms.content.as(composer('A'));
    expect(await api.updateEach('score', [])).toEqual([]);
    await expect(api.updateEach('score', [{ id: row!.id, patch: { title: 'a' } }, { id: row!.id, patch: { title: 'b' } }])).rejects.toBeInstanceOf(ValidationError);
    await expect(w.cms.content.as(system('x')).updateEach('page', [{ id: 'p', patch: { title: 'a' } }])).rejects.toBeInstanceOf(Forbidden);
  });
});
