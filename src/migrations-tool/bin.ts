#!/usr/bin/env node
/**
 * `cogens-print-migration <config file>`: prints the SQL the config's indexed fields need (see `index.ts`).
 *
 * The config's default export is `{ contentTypes }` (what `defineConfig` returns). Under Bun any config file
 * loads, `.ts` included (`bunx cogens-print-migration site.config.ts`). Under Node the file is imported as
 * is: `.js` and `.mjs` always work, and a `.ts` config only on a Node that strips types (22.18 or later,
 * 24 and up) when the config's own imports are plain relative `.ts` or package imports.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ContentType } from '../core/config/define.ts';
import { migrationLines } from './index.ts';

// The declaration keeps this file free of Node's types, which a Worker build does not have.
declare const process: { argv: string[]; cwd(): string; exitCode?: number };

const path = process.argv[2];
if (!path) {
  console.error('Usage: cogens-print-migration <config file>');
  process.exitCode = 1;
} else {
  try {
    const module = await import(pathToFileURL(resolve(process.cwd(), path)).href);
    const config = module.default as { contentTypes?: ContentType<any>[] } | undefined;
    if (!config || !Array.isArray(config.contentTypes)) {
      throw new Error(`${path} must default-export { contentTypes } (what defineConfig returns).`);
    }
    console.log(migrationLines(config.contentTypes).join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
