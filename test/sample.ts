/** A small host for the store's tests: composers who own scores, and a page the admin edits. */
import { admin, anonymous, contentType, createCms, field, system, type AccessContext, type Cms, type Principal, type WriteContext } from '../src/core/index.ts';
import { countD1, createDb, type D1Count, type TestDb } from './support.ts';

export interface Composer {
  kind: 'composer';
  ownerIds: string[];
  cloud: 'current' | 'lapsed';
}
export const composer = (...ownerIds: string[]): Composer => ({ kind: 'composer', ownerIds, cloud: 'current' });
export const lapsed = (...ownerIds: string[]): Composer => ({ ...composer(...ownerIds), cloud: 'lapsed' });

export const score = contentType({
  id: 'score',
  name: 'Scores',
  displayField: 'title',
  owned: true,
  uniqueSlug: true,
  indexed: ['visibility', 'retired'],
  fields: {
    title: field.text('Title').required().max(200),
    composer: field.text('Composer'),
    visibility: field.select('Visibility', { options: ['public', 'link'] }),
    rights: field.text('Rights'),
    currentRevision: field.number('Current revision').system(),
    retired: field.number('Retired').system().default(0),
    unpublishedAt: field.date('Unpublished at').system()
  },
  access(principal: Principal<Composer>, { can }: AccessContext) {
    // Anyone reads a published public score, and any published score by its slug.
    can('read', { where: { status: 'published', visibility: 'public' } });
    can('read', { bySlug: true, where: { status: 'published' } });
    if (principal.kind === 'composer') {
      const own = { owner_id: { in: principal.ownerIds }, retired: 0 };
      can('read', { where: own });
      can(['update', 'delete'], { where: own, fields: ['title', 'composer', 'visibility', 'rights'] });
      if (principal.cloud === 'current') can('create', { where: { owner_id: { in: principal.ownerIds } } });
    }
    if (principal.kind === 'admin') {
      can('read');
      can('publish');
      can('delete');
    }
    if (principal.kind === 'system') {
      can('read');
      can('create', { fields: ['title', 'composer', 'visibility', 'rights', 'retired'] });
      can('publish', { fields: ['unpublishedAt', 'retired'] });
      can('update', { fields: ['currentRevision', 'unpublishedAt', 'retired', 'owner_id'] });
    }
  }
});

export const page = contentType({
  id: 'page',
  name: 'Pages',
  displayField: 'title',
  uniqueSlug: true,
  fields: { title: field.text('Title').required(), body: field.markdown('Body') },
  access(principal: Principal<Composer>, { can }: AccessContext) {
    can('read', { where: { status: 'published' } });
    if (principal.kind === 'admin') can(['create', 'read', 'update', 'delete', 'publish']);
  }
});

export interface World {
  t: TestDb;
  /** What the store's D1 binding has run (the store is built over a counting wrapper). */
  count: D1Count;
  cms: Cms<Composer>;
  ids: number;
  dispose(): Promise<void>;
}

export async function createWorld(
  types: Parameters<typeof createCms>[0]['types'] = [score, page],
  extra: Partial<Parameters<typeof createCms<Composer>>[0]> = {}
): Promise<World> {
  const t = await createDb();
  let n = 0;
  let cms: Cms<Composer>;
  const { db, count } = countD1(t.db);
  try {
    cms = createCms<Composer>({
      db,
      types,
      probes: [composer('probe'), lapsed('probe')],
      newId: () => `id-${String(++n).padStart(4, '0')}`,
      ...extra
    });
  } catch (error) {
    await t.dispose();
    throw error;
  }
  return { t, count, cms, ids: 0, dispose: () => t.dispose() };
}

export { admin, anonymous, system };
export type { WriteContext };
