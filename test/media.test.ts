/** Task 3.11 (the store half): media is upload, list and delete, under the same access check as entries. */
import { expect, test } from 'bun:test';
import { Forbidden, ValidationError, createCms, type Principal } from '../src/core/index.ts';
import { admin, anonymous, composer, score, system, type Composer } from './sample.ts';
import { createDb } from './support.ts';

test('upload, list, get and delete are scoped to the owner', async () => {
  const t = await createDb();
  let n = 0;
  const cms = createCms<Composer>({
    db: t.db,
    types: [score],
    media: {
      bucket: t.r2,
      newId: () => `asset-${++n}`,
      maxBytes: 1000,
      access: (principal: Principal<Composer>, { can }) => {
        if (principal.kind === 'composer') can(['create', 'read', 'delete'], { where: { owner_id: { in: principal.ownerIds } } });
        if (principal.kind === 'admin') can('read');
      }
    }
  });
  const a = cms.media!.as(composer('A'));
  const b = cms.media!.as(composer('B'));
  const one = await a.upload({ name: 'cover.png', contentType: 'image/png', body: new Uint8Array([1, 2, 3]), ownerId: 'A' });
  expect(one).toMatchObject({ id: 'asset-1', owner_id: 'A', name: 'cover.png', content_type: 'image/png', size: 3, key: 'media/asset-1' });
  expect(await (await t.r2.get('media/asset-1'))!.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);

  await b.upload({ name: 'other.png', contentType: 'image/png', body: new Uint8Array([9]), ownerId: 'B' });
  expect((await a.list()).map(x => x.id)).toEqual(['asset-1']);
  expect((await b.list()).map(x => x.id)).toEqual(['asset-2']);
  expect((await cms.media!.as(admin()).list()).map(x => x.id).sort()).toEqual(['asset-1', 'asset-2']);
  expect(await b.get('asset-1')).toBeNull();
  expect((await a.get('asset-1'))?.name).toBe('cover.png');

  // Another owner's asset cannot be deleted, and nothing happens to it.
  await expect(b.remove('asset-1')).rejects.toMatchObject({ operation: 'delete' });
  expect(await t.r2.get('media/asset-1')).not.toBeNull();
  await a.remove('asset-1');
  expect(await a.get('asset-1')).toBeNull();
  expect(await t.r2.get('media/asset-1')).toBeNull();

  // Default deny: anonymous, the system caller and a composer uploading for another owner can do nothing.
  await expect(cms.media!.as(anonymous).upload({ name: 'x', contentType: 'image/png', body: new Uint8Array([1]) })).rejects.toBeInstanceOf(Forbidden);
  await expect(cms.media!.as(system('job')).upload({ name: 'x', contentType: 'image/png', body: new Uint8Array([1]), ownerId: 'A' })).rejects.toBeInstanceOf(Forbidden);
  await expect(a.upload({ name: 'x', contentType: 'image/png', body: new Uint8Array([1]), ownerId: 'B' })).rejects.toBeInstanceOf(Forbidden);
  expect(await cms.media!.as(anonymous).list()).toEqual([]);
  await expect(cms.media!.as(admin()).remove('asset-2')).rejects.toBeInstanceOf(Forbidden);

  // A file over the limit, and no name.
  await expect(a.upload({ name: 'big', contentType: 'image/png', body: new Uint8Array(1001), ownerId: 'A' })).rejects.toBeInstanceOf(ValidationError);
  await expect(a.upload({ name: ' ', contentType: 'image/png', body: new Uint8Array(1), ownerId: 'A' })).rejects.toBeInstanceOf(ValidationError);
  await t.dispose();
});

test('a host without media has none', async () => {
  const t = await createDb();
  expect(createCms({ db: t.db, types: [score] }).media).toBeNull();
  await t.dispose();
});
