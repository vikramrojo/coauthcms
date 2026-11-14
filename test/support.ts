/** A Miniflare D1 with the package's own migrations applied, for the store's tests. */
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { contentType, field } from '../src/core/index.ts';
import { migrationLines } from '../scripts/print-migration.ts';

/** The statements of a file under migrations/ (`auth/0001_sessions.sql` for the auth package's). */
export function statements(file: string): string[] {
  const text = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  return text.split(';').map(s => s.trim()).filter(Boolean);
}

/** What a test host's types index: the lines `print-migration` prints for them go after the package's own migrations. */
const indexedTypes = [
  contentType({ id: 'score', name: 'Scores', displayField: 'title', uniqueSlug: true, indexed: ['visibility', 'retired'], fields: { title: field.text('Title'), visibility: field.text('V'), retired: field.number('R') } }),
  contentType({ id: 'page', name: 'Pages', displayField: 'title', uniqueSlug: true, fields: { title: field.text('Title'), visibility: field.text('V'), retired: field.number('R') } })
];

export const PACKAGE_MIGRATIONS = ['0001_entries.sql', 'auth/0001_sessions.sql'];

/** The package's migrations, then the printed lines for the test types (columns `f_visibility` and `f_retired`, a unique slug). */
export async function migrate(db: D1Database, files = PACKAGE_MIGRATIONS, printed: string[] | null = migrationLines(indexedTypes)): Promise<void> {
  for (const file of files) for (const statement of statements(file)) await db.prepare(statement).run();
  for (const line of printed ?? []) await db.prepare(line).run();
}

export interface TestDb {
  db: D1Database;
  r2: R2Bucket;
  dispose(): Promise<void>;
}

export async function createDb(options: { migrations?: string[]; printed?: string[] | null; skipMigrations?: boolean } = {}): Promise<TestDb> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    d1Databases: { DB: 'store-test-db' },
    r2Buckets: { FILES: 'store-test-files' }
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const r2 = (await mf.getR2Bucket('FILES')) as unknown as R2Bucket;
  if (!options.skipMigrations) await migrate(db, options.migrations, options.printed);
  return { db, r2, dispose: () => mf.dispose() };
}

/** What a counted D1 binding has seen. A batch is one round trip however many statements it holds. */
export interface D1Count {
  /** Statements run on their own (run, first, all, raw). */
  single: number;
  /** The statement count of each `batch` call. */
  batches: number[];
  /** Round trips: the single statements and the batches. */
  readonly trips: number;
  /** Every statement executed, those inside batches too. */
  readonly statements: number;
  /** Awaited just before each batch runs (a concurrent writer, in a test). */
  beforeBatch?: () => Promise<void>;
  reset(): void;
}

/** A D1 binding that counts what runs through it, and otherwise behaves as `db` does. */
export function countD1(db: D1Database): { db: D1Database; count: D1Count } {
  const count: D1Count = {
    single: 0,
    batches: [],
    get trips() {
      return this.single + this.batches.length;
    },
    get statements() {
      return this.single + this.batches.reduce((n, b) => n + b, 0);
    },
    reset() {
      this.single = 0;
      this.batches = [];
    }
  };
  const targets = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (typeof value !== 'function') return value;
        if (prop === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args));
        if (prop === 'run' || prop === 'first' || prop === 'all' || prop === 'raw') {
          return (...args: unknown[]) => {
            count.single++;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      }
    });
    targets.set(proxy, statement);
    return proxy;
  };
  const counted = new Proxy(db, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          count.batches.push(statements.length);
          await count.beforeBatch?.();
          return target.batch(statements.map(s => targets.get(s) ?? s));
        };
      }
      return value.bind(target);
    }
  });
  return { db: counted, count };
}
