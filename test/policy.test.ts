/** Task 3.9: the policy matrix helper and `cms.access.rulesFor`. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PolicyMismatch, contentType, createCms, field, permits, policyMatrix, type PackedRules } from '../src/core/index.ts';
import { admin, anonymous, composer, createWorld, lapsed, page, score, system, type Composer, type World } from './sample.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.dispose());

const callers = {
  anonymous,
  composerA: composer('A'),
  lapsedA: lapsed('A'),
  admin: admin(),
  system: system('job')
};

const expect_ = {
  anonymous: { score: ['read', 'lookup'], page: ['read', 'lookup'] },
  composerA: { score: ['create', 'read', 'lookup', 'update', 'delete'], page: ['read', 'lookup'] },
  lapsedA: { score: ['read', 'lookup', 'update', 'delete'], page: ['read', 'lookup'] },
  admin: { score: ['read', 'lookup', 'publish', 'delete'], page: ['create', 'read', 'lookup', 'update', 'delete', 'publish'] },
  system: { score: ['create', 'read', 'lookup', 'update', 'publish'], page: ['read', 'lookup'] }
} as const;

const rows = {
  score: [
    { id: '1', owner_id: 'A', status: 'draft', visibility: 'link', retired: 0 },
    { id: '2', owner_id: 'B', status: 'published', visibility: 'public', retired: 0 },
    { id: '3', owner_id: 'A', status: 'published', visibility: 'public', retired: 1 },
    { id: '6', owner_id: 'B', status: 'draft', visibility: 'link', retired: 0 }
  ],
  page: [{ id: '4', status: 'published' }, { id: '5', status: 'draft' }]
};

describe('the policy matrix', () => {
  test('passes for the rules as written', () => {
    policyMatrix({ cms: w.cms, callers, expect: expect_ as never, rows });
  });

  test('shows a page the controls a caller has', () => {
    const rules = w.cms.access.rulesFor(composer('A'));
    expect(permits(rules, 'score', 'create')).toBe(true);
    expect(permits(rules, 'score', 'publish')).toBe(false);
    expect(permits(rules, 'score', 'read', { owner_id: 'A', retired: 0 })).toBe(true);
    expect(permits(rules, 'score', 'read', { owner_id: 'B', retired: 0, status: 'draft' })).toBe(false);
    expect(permits(w.cms.access.rulesFor(lapsed('A')), 'score', 'create')).toBe(false);
    expect(permits(w.cms.access.rulesFor(anonymous), 'page', 'update')).toBe(false);
    // Plain JSON: it can be sent to a browser as it is.
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
  });

  test('fails when a grant is removed, naming the caller and the operation', async () => {
    const weaker = contentType({
      ...score,
      fields: score.fields,
      access: (principal: any, ctx) => {
        // Composers lose update and delete.
        if (principal.kind === 'composer') {
          ctx.can('read', { where: { owner_id: { in: principal.ownerIds }, retired: 0 } });
          if (principal.cloud === 'current') ctx.can('create', { where: { owner_id: { in: principal.ownerIds } } });
          return;
        }
        score.access!(principal, ctx);
      }
    });
    const world = await createWorld([weaker, page]);
    const error = (() => {
      try {
        policyMatrix({ cms: world.cms, callers, expect: expect_ as never, rows });
      } catch (e) {
        return e as PolicyMismatch;
      }
    })();
    expect(error).toBeInstanceOf(PolicyMismatch);
    expect(error!.failures).toContain('composerA / score / update: expected allowed, the rules deny it');
    expect(error!.failures).toContain('composerA / score / delete: expected allowed, the rules deny it');
    expect(error!.failures).toContain('lapsedA / score / update: expected allowed, the rules deny it');
    expect(error!.message).toContain('composerA / score / update');
    expect(error!.failures.some(f => f.startsWith('admin'))).toBe(false);
    await world.dispose();
  });

  test('fails when a grant is added the expectations do not list', async () => {
    const wider = contentType({
      ...page,
      fields: page.fields,
      access: (principal: any, ctx) => {
        page.access!(principal, ctx);
        if (principal.kind === 'anonymous') ctx.can('create');
      }
    });
    const world = await createWorld([score, wider]);
    expect(() => policyMatrix({ cms: world.cms, callers, expect: expect_ as never, rows })).toThrow(/anonymous \/ page \/ create: expected denied/);
    await world.dispose();
  });

  test('fails when the packed rules disagree with enforcement', () => {
    const drop = (rules: PackedRules): PackedRules =>
      rules.map(r => (r.type === 'score' ? { ...r, grants: r.grants.filter(g => g.operation !== 'delete') } : r));
    const error = (() => {
      try {
        policyMatrix({ cms: w.cms, callers, expect: expect_ as never, rules: p => drop(w.cms.access.rulesFor(p)) });
      } catch (e) {
        return e as PolicyMismatch;
      }
    })();
    expect(error).toBeInstanceOf(PolicyMismatch);
    expect(error!.failures).toContain('composerA / score / delete: the packed rules deny it, enforcement allows it');
    expect(error!.failures.some(f => f.startsWith('anonymous'))).toBe(false);
  });

  test('fails when a packed condition disagrees on a row', () => {
    const loosen = (rules: PackedRules): PackedRules =>
      rules.map(r => ({ ...r, grants: r.grants.map(g => (g.operation === 'read' && g.where && 'owner_id' in g.where ? { ...g, where: { retired: 0 } } : g)) }));
    expect(() =>
      policyMatrix({ cms: w.cms, callers: { composerA: callers.composerA }, expect: { composerA: expect_.composerA } as never, rows, rules: p => loosen(w.cms.access.rulesFor(p)) })
    ).toThrow(/composerA \/ score \/ read on row .*the packed rules allow it, enforcement denies it/s);
  });

  test('a caller or type the expectations leave out may do nothing', () => {
    expect(() => policyMatrix({ cms: w.cms, callers: { admin: admin() }, expect: {} })).toThrow(/admin \/ score \/ read: expected denied/);
  });

  test('rulesFor leaves out external collections and names every stored type', () => {
    const external = contentType({ id: 'revision', name: 'R', displayField: 'label', service: { readOnly: true }, fields: { label: field.text('L') } });
    const cms = createCms({ db: w.t.db, types: [score, page, external] });
    expect(cms.access.rulesFor(admin()).map(r => r.type)).toEqual(['score', 'page']);
  });
});
