/**
 * `cogens/testing`: the policy test helper (`policyMatrix`, which uses no test framework) and `createTestDb`, a
 * Miniflare D1 with the package's migrations and the host's own applied. Miniflare is an optional peer dependency,
 * imported only when `createTestDb` runs; the Worker and core never import this folder.
 */
export { policyMatrix, PolicyMismatch } from '../core/testing/index.ts';
export type { PolicyMatrixOptions, Expectation } from '../core/testing/index.ts';
export { createTestDb } from './db.ts';
export type { TestDb, TestDbOptions } from './db.ts';
