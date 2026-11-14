/** Task 2.2: the `can` builder, the principal kinds, and that nothing of the engine under them is exported. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuleSet } from '../src/core/access/ability.ts';
import { runAccess } from '../src/core/access/can.ts';
import * as core from '../src/core/index.ts';
import { admin, anonymous, system, type AccessContext, type Principal } from '../src/core/index.ts';
import { assertPrincipal } from '../src/core/principal.ts';
import { specifiers } from './imports.ts';

interface Composer {
  kind: 'composer';
  ownerId: string;
  cloud: 'current' | 'lapsed';
}

function access(principal: Principal<Composer>, { can }: AccessContext) {
  can('read', { where: { status: 'published' } });
  if (principal.kind === 'composer') {
    can('read', { where: { owner_id: principal.ownerId } });
    can('update', { where: { owner_id: principal.ownerId }, fields: ['title'] });
    if (principal.cloud === 'current') can('create', { where: { owner_id: principal.ownerId } });
  }
  if (principal.kind === 'admin') can(['read', 'publish']);
  if (principal.kind === 'system') can('update', { fields: ['currentRevision'] });
}

const rules = (principal: Principal<Composer>) => new RuleSet('t', runAccess(access, principal));
const row = (over: Record<string, unknown> = {}) => ({ id: '1', owner_id: 'A', slug: null, status: 'draft', parent_id: null, parent_status: null, ...over });

describe('abilities for each kind of principal', () => {
  test('anonymous reads published rows only and writes nothing', () => {
    const r = rules(anonymous);
    expect(r.allows('read', row({ status: 'published' }))).toBe(true);
    expect(r.allows('read', row())).toBe(false);
    for (const op of ['create', 'update', 'delete', 'publish'] as const) expect(r.has(op)).toBe(false);
  });

  test('admin: what the rule grants and nothing more', () => {
    const r = rules(admin('maintainer'));
    expect(r.allows('read', row())).toBe(true);
    expect(r.has('publish')).toBe(true);
    for (const op of ['create', 'update', 'delete'] as const) expect(r.has(op)).toBe(false);
  });

  test('system: the one grant its rule lists, by field', () => {
    const r = rules(system('commit'));
    expect(r.has('update')).toBe(true);
    expect(r.permittedFields('update', row())).toEqual({ ordinary: false, listed: new Set(['currentRevision']) });
    expect(r.has('create')).toBe(false);
  });

  test('a host kind: conditions come from its claims, and the lapsed one cannot create', () => {
    const live = rules({ kind: 'composer', ownerId: 'A', cloud: 'current' });
    expect(live.allows('read', row({ owner_id: 'A' }))).toBe(true);
    expect(live.allows('read', row({ owner_id: 'B' }))).toBe(false);
    expect(live.allows('create', row({ owner_id: 'A' }))).toBe(true);
    expect(live.allows('create', row({ owner_id: 'B' }))).toBe(false);
    expect(live.permittedFields('update', row())).toEqual({ ordinary: false, listed: new Set(['title']) });
    expect(live.permittedFields('update', row({ owner_id: 'B' }))).toEqual({ ordinary: false, listed: new Set() });
    const late = rules({ kind: 'composer', ownerId: 'A', cloud: 'lapsed' });
    expect(late.has('create')).toBe(false);
    expect(late.allows('read', row())).toBe(true);
  });

  test('a grant with no field list lets every ordinary field through', () => {
    const r = new RuleSet('t', runAccess((_p, { can }) => can('update'), anonymous));
    expect(r.permittedFields('update', row())).toEqual({ ordinary: true, listed: new Set() });
  });

  test('a slug-only grant answers a lookup and not a read', () => {
    const r = new RuleSet('t', runAccess((_p, { can }) => can('read', { bySlug: true, where: { status: 'published' } }), anonymous));
    expect(r.allows('read', row({ status: 'published' }))).toBe(false);
    expect(r.allowsLookup(row({ status: 'published' }))).toBe(true);
    expect(r.allowsLookup(row())).toBe(false);
  });

  test('the builder refuses an operation it does not know and a by-slug grant of anything but read', () => {
    expect(() => runAccess((_p, { can }) => can('explode' as never), anonymous)).toThrow(/Unknown operation/);
    expect(() => runAccess((_p, { can }) => can('update', { bySlug: true }), anonymous)).toThrow(/read only/);
    expect(() => runAccess((_p, { can }) => can([]), anonymous)).toThrow(/at least one/);
  });
});

describe('principals', () => {
  test('a system principal names its job', () => {
    expect(system('purge')).toEqual({ kind: 'system', job: 'purge' });
    expect(() => system('')).toThrow(/job/);
    expect(() => assertPrincipal({ kind: 'system' })).toThrow(/job/);
    expect(() => assertPrincipal(null)).toThrow(/kind/);
    expect(() => assertPrincipal({})).toThrow(/kind/);
    expect(Object.isFrozen(admin())).toBe(true);
  });
});

describe('the engine is not exported', () => {
  const CORE = resolve(import.meta.dir, '../src/core');
  const all = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? all(path) : path.endsWith('.ts') ? [path] : [];
    });

  test('only access/ability.ts imports it, and index.ts exports nothing from that file', () => {
    const importers = all(CORE).filter(f => specifiers(readFileSync(f, 'utf8')).some(s => s.startsWith('@casl')));
    expect(importers.map(f => f.slice(CORE.length + 1))).toEqual(['access/ability.ts']);
    expect(specifiers(readFileSync(join(CORE, 'index.ts'), 'utf8')).some(s => s.includes('ability'))).toBe(false);
  });

  test('no export is named for it, and no other file names one of its types', () => {
    const names = Object.keys(core);
    for (const casl of ['Ability', 'AbilityBuilder', 'createMongoAbility', 'subject', 'ForbiddenError', 'defineAbility', 'RuleSet', 'MongoAbility']) {
      expect(names).not.toContain(casl);
    }
    for (const file of all(CORE).filter(f => !f.endsWith('access/ability.ts'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/MongoAbility|AbilityBuilder|RawRule|createMongoAbility/);
    }
  });
});
