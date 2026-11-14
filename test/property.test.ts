/**
 * Task 2.4: the compiled SQL and the in-memory answer agree. Random rows and
 * random rules (equals, in, and, or, to depth three, one to three grants), the
 * compiler's SQL run on a real in-memory D1, the same rules asked of the ability
 * for each row. The compiler is what keeps one tenant out of another's rows, so
 * this is the test that stands between a bug in it and a leak.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RuleSet } from '../src/core/access/ability.ts';
import { runAccess } from '../src/core/access/can.ts';
import { compileAny, type Sql } from '../src/core/access/compile.ts';
import { contentType, field, type Where } from '../src/core/index.ts';
import { columnOf } from '../src/core/store/content.ts';
import { createDb, type TestDb } from './support.ts';

const type = contentType({
  id: 'probe',
  name: 'Probe',
  displayField: 'visibility',
  indexed: ['visibility', 'retired'],
  fields: { visibility: field.text('V'), retired: field.json('R') }
});

/** A small seeded generator (mulberry32), so a failing case can be run again. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const between = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const POOLS: Record<string, readonly (string | number | boolean)[]> = {
  owner_id: ['A', 'B', 'C', 'Z'],
  slug: ['s1', 's2', 'sz'],
  status: ['draft', 'published'],
  parent_id: ['p1', 'p2', 'pz'],
  parent_status: ['published', 'draft'],
  visibility: ['public', 'link', 'other'],
  retired: [0, 1, true, false]
};
const FIELDS = Object.keys(POOLS);

function genWhere(r: Rng, depth: number): Where {
  const roll = r();
  if (depth > 0 && roll < 0.2) return { and: Array.from({ length: between(r, 1, 3) }, () => genWhere(r, depth - 1)) };
  if (depth > 0 && roll < 0.45) return { or: Array.from({ length: between(r, 1, 3) }, () => genWhere(r, depth - 1)) };
  const where: Record<string, unknown> = {};
  for (let i = between(r, 1, 2); i > 0; i--) {
    const name = pick(r, FIELDS);
    const pool = POOLS[name]!;
    where[name] = r() < 0.5 ? pick(r, pool) : { in: Array.from({ length: between(r, 0, 4) }, () => pick(r, pool)) };
  }
  return where as Where;
}

interface Row {
  id: string;
  owner_id: string | null;
  slug: string | null;
  status: string;
  parent_id: string | null;
  parent_status: string | null;
  data: { visibility?: string; retired?: number | boolean };
}

function genRow(r: Rng, i: number): Row {
  const maybe = <T>(value: T): T | null => (r() < 0.2 ? null : value);
  return {
    id: `r${i}`,
    owner_id: maybe(pick(r, ['A', 'B', 'C'])),
    slug: maybe(pick(r, ['s1', 's2'])),
    status: pick(r, ['draft', 'published']),
    parent_id: maybe(pick(r, ['p1', 'p2'])),
    parent_status: maybe(pick(r, ['published', 'draft'])),
    data: {
      ...(r() < 0.8 ? { visibility: pick(r, ['public', 'link']) } : {}),
      ...(r() < 0.8 ? { retired: pick(r, [0, 1, true, false]) } : {})
    }
  };
}

/** The row as the ability sees it, written here and not taken from the store so the oracle shares nothing with it. */
const oracleRow = (row: Row) => ({
  id: row.id,
  owner_id: row.owner_id,
  slug: row.slug,
  status: row.status,
  parent_id: row.parent_id,
  parent_status: row.parent_status,
  ...(row.data.visibility === undefined ? {} : { visibility: row.data.visibility }),
  ...(row.data.retired === undefined ? {} : { retired: typeof row.data.retired === 'boolean' ? Number(row.data.retired) : row.data.retired })
});

type Compile = (conditions: (Where | undefined)[]) => Sql | null;
const real: Compile = conditions => compileAny(conditions, columnOf(type));
/** The `or` branch broken on purpose: alternatives become requirements. */
const broken: Compile = conditions => {
  const compiled = real(conditions);
  return compiled && { ...compiled, sql: compiled.sql.replaceAll(' OR ', ' AND ') };
};

let t: TestDb;
beforeAll(async () => {
  t = await createDb();
});
afterAll(() => t.dispose());

/** Runs `cases` random cases and returns the ones where SQL and the ability disagree. */
async function run(cases: number, compile: Compile, seed = 20261114) {
  const r = rng(seed);
  const disagreements: { case: number; grants: Where[]; sql: unknown; missing: string[]; extra: string[] }[] = [];
  for (let n = 0; n < cases; n++) {
    const rows = Array.from({ length: 24 }, (_, i) => genRow(r, i));
    const grants = Array.from({ length: between(r, 1, 3) }, () => genWhere(r, 3));
    const compiled = compile(grants);
    await t.db.batch(
      rows.map(row =>
        t.db
          .prepare('INSERT INTO entries (id, content_type, owner_id, slug, status, parent_id, parent_status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(row.id, 'probe', row.owner_id, row.slug, row.status, row.parent_id, row.parent_status, JSON.stringify(row.data))
      )
    );
    const ids = ((await t.db.prepare(`SELECT id FROM entries WHERE content_type = 'probe' AND (${compiled!.sql})`).bind(...compiled!.params).all<{ id: string }>()).results ?? [])
      .map(x => x.id)
      .sort();
    await t.db.prepare("DELETE FROM entries WHERE content_type = 'probe'").run();
    const rules = new RuleSet('probe', runAccess((_p, { can }) => grants.forEach(where => can('read', { where })), null));
    const expected = rows.filter(row => rules.allows('read', oracleRow(row))).map(row => row.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      disagreements.push({
        case: n,
        grants,
        sql: compiled,
        missing: expected.filter(id => !ids.includes(id)),
        extra: ids.filter(id => !expected.includes(id))
      });
    }
  }
  return disagreements;
}

describe('compiled SQL against the in-memory ability', () => {
  test('500 generated cases agree', async () => {
    const found = await run(500, real);
    if (found.length > 0) console.error(JSON.stringify({ ...found[0], grants: JSON.stringify(found[0]!.grants) }));
    expect(found).toHaveLength(0);
  }, 120_000);

  test('breaking the `or` branch on purpose makes them fail', async () => {
    const found = await run(500, broken);
    expect(found.length).toBeGreaterThan(0);
  }, 120_000);

  test('the generator reaches rows that match and rows that do not, in both answers', async () => {
    const r = rng(7);
    let matched = 0;
    let total = 0;
    for (let n = 0; n < 200; n++) {
      const rows = Array.from({ length: 24 }, (_, i) => genRow(r, i));
      const rules = new RuleSet('probe', runAccess((_p, { can }) => can('read', { where: genWhere(r, 3) }), null));
      for (const row of rows) {
        total++;
        if (rules.allows('read', oracleRow(row))) matched++;
      }
    }
    expect(matched / total).toBeGreaterThan(0.05);
    expect(matched / total).toBeLessThan(0.95);
  });
});
