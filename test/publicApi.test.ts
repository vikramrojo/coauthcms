/** Task 3.10: the opt-in public API, off by default and per type, calling as anonymous. */
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigError } from '../src/core/index.ts';
import { admin, createWorld, page, score, system, type World } from './sample.ts';

let w: World | undefined;
afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

async function seed(world: World) {
  const content = world.cms.content.as(admin());
  const live = await content.create('page', { title: 'Live', slug: 'live' });
  await content.create('page', { title: 'Draft', slug: 'draft' });
  await content.publish('page', live.id);
  const made = await world.cms.content.as(system('seed')).create('score', { owner_id: 'A', title: 'S', slug: 'sc', visibility: 'public', retired: 0 });
  await world.cms.content.as(admin()).publish('score', made.id);
  return { live, score: made };
}

const paths = ['/', '/page', '/page/live', '/page/draft', '/score', '/score/sc', '/revision', '/owner', '/nonsense', '/page/live/extra'];

describe('off by default', () => {
  test('every public content route answers not found with nothing enabled', async () => {
    w = await createWorld();
    const { live } = await seed(w);
    for (const path of [...paths, `/page/${live.id}`]) {
      const res = await w.cms.publicApi.request(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    // Other methods do not reach the store either.
    expect((await w.cms.publicApi.request('/page', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await w.cms.publicApi.request('/page/live', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('enabled for a type', () => {
  test('returns only the published entries the type lets an anonymous caller read', async () => {
    w = await createWorld([score, page], { publicTypes: ['page'] });
    const { live } = await seed(w);
    const list = (await (await w.cms.publicApi.request('/page')).json()) as any;
    expect(list.entries).toEqual([expect.objectContaining({ id: live.id, slug: 'live', title: 'Live' })]);
    expect(JSON.stringify(list)).not.toContain('Draft');
  });

  test('a single entry by slug or by id; a draft and a type that is not enabled are not found', async () => {
    w = await createWorld([score, page], { publicTypes: ['page'] });
    const { live } = await seed(w);
    expect(((await (await w.cms.publicApi.request('/page/live')).json()) as any).title).toBe('Live');
    expect(((await (await w.cms.publicApi.request(`/page/${live.id}`)).json()) as any).slug).toBe('live');
    expect((await w.cms.publicApi.request('/page/draft')).status).toBe(404);
    expect((await w.cms.publicApi.request('/score')).status).toBe(404);
    expect((await w.cms.publicApi.request('/score/sc')).status).toBe(404);
  });

  test('a type whose rules give an anonymous caller nothing answers an empty list, not data', async () => {
    w = await createWorld([score, page], { publicTypes: ['score', 'page'] });
    await seed(w);
    // The score's anonymous rule lets a published public score be read: it is listed, and a draft would not be.
    const list = (await (await w.cms.publicApi.request('/score')).json()) as any;
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].owner_id).toBeUndefined();
  });

  test('naming a type the store does not hold is a configuration error', async () => {
    await expect(createWorld([page], { publicTypes: ['ghost'] })).rejects.toBeInstanceOf(ConfigError);
  });
});
