import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface TestDbOptions {
  /** The host's own SQL files (paths, relative to the working directory), applied in order after the package's. */
  migrations?: string[];
}

export interface TestDb {
  db: D1Database;
  r2: R2Bucket;
  dispose(): Promise<void>;
}

/** The package's own migrations, in the order a host applies them. */
const PACKAGE_MIGRATIONS = ['0001_entries.sql', 'auth/0001_sessions.sql'];

/** The statements of a SQL file with `--` comment lines dropped. */
function statements(path: string | URL): string[] {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  return text.split(';').map(s => s.trim()).filter(Boolean);
}

/**
 * A Miniflare D1 (`db`) and R2 bucket (`r2`) with the package's migrations applied, then each file of
 * `options.migrations` (the host's columns, indexes and tables). Call `dispose()` when the test is done.
 * Needs `miniflare` installed in the host (`bun add -d miniflare`).
 */
export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const { Miniflare } = await import('miniflare');
  const mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    d1Databases: { DB: 'cogens-test-db' },
    r2Buckets: { FILES: 'cogens-test-files' }
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const r2 = (await mf.getR2Bucket('FILES')) as unknown as R2Bucket;
  const files = [
    ...PACKAGE_MIGRATIONS.map(f => new URL(`../../migrations/${f}`, import.meta.url)),
    ...(options.migrations ?? []).map(f => resolve(process.cwd(), f))
  ];
  try {
    for (const file of files) for (const statement of statements(file)) await db.prepare(statement).run();
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  return { db, r2, dispose: () => mf.dispose() };
}
