# Changelog

## 0.2.1

- The package now ships compiled JavaScript (ES modules) with `.d.ts` declarations, declaration maps and source maps in `dist/`. `exports` point there, so Node 20 or later, Vitest and Node scripts can import it; Node refuses `.ts` files under `node_modules`. Wrangler and Bun are unaffected.
- `cogens-print-migration` runs under Node (`#!/usr/bin/env node`): `.js` and `.mjs` configs always, `.ts` configs on a Node that strips types. The printer moved from `scripts/print-migration.ts` to `src/migrations-tool/`; the `cogens/migrations-tool` import is unchanged, and `cogens/scripts/print-migration.ts` is gone.
- `scripts/build-admin-editor.ts` stays Bun-only and stays a shipped `.ts` script.
- `engines` gains `node >=20`.

## 0.2.0

- Renamed from coauthcms to cogens. Publishable: README for a public audience, `LICENSE` and `NOTICE`, `hono` pinned to `~4.12.2`.
- Editor plugins receive the field's type and name and replace the built-in directive syntax; `createTestDb`; `migrations-tool` and `scripts` exports.

## 0.1.1

- Sinfon's directive syntax applies only to notebook fields in the admin.

## 0.1.0

- Extracted from Sinfon's `site/packages` (a multi-tenant fork of Koguma): content types, access rules, principals, the server-rendered admin and the session tables.
