# cogens

A light multi-tenant content store for Cloudflare Workers (D1, R2, Hono). Every entry may have an owner, and every query passes an access check: you cannot write a read or a write without saying who is calling, and a read the caller may not make answers as a missing row.

It is a fork of [Koguma](https://github.com/m4ttheweric/koguma) (MIT). Koguma's database and config code is the starting point; the access engine, the principal model, the server-rendered admin and the session tables are new. See `NOTICE`.

One package, these entry points:

| Import | What it is | Runtime dependencies it uses |
| --- | --- | --- |
| `cogens` | The store: content types and fields, access rules, `createCms`, `content.as(principal)`, media, the policy test helper | `hono`, `@casl/ability`, `@cfworker/json-schema` |
| `cogens/admin` | The admin: server-rendered Hono pages that are an ordinary client of `content.as` | `hono` and core |
| `cogens/auth` | Sessions on D1 rows, one-time handoff tokens, the operator's password sign-in | `hono` |
| `cogens/testing` | The policy matrix helper (also exported from `cogens`) and `createTestDb`, a Miniflare D1 with the migrations applied | none; `createTestDb` needs `miniflare` in the host |
| `cogens/migrations-tool` | `migrationLines`, the function behind `cogens-print-migration` | core's types only |

The package's `dependencies` are those three and no more; a test (`test/boundary.test.ts`) fails if core imports a fourth, if admin imports anything of ours but core, if auth imports core or admin, or if anything outside `src/core/store` reaches the SQL layer. No React anywhere.

It is a library you embed in your own Worker. It is not a hosted service, a standalone CMS with its own sign-in for end users, or a React dashboard: you supply the sign-in and say who is calling; the package supplies the store, the access checks and a small server-rendered admin. It was written for [Sinfon](https://sinfon.app), the first host, and is used there.

Status: 0.2.0, pre-1.0. The API may change before 1.0.

## Install

```sh
bun add cogens
# or
npm install cogens
```

For bundlers that compile TypeScript, such as Wrangler (esbuild) and Bun. The package ships TypeScript source: `exports` point at `.ts` files, so there is no build step and no `dist/`. Node does not run `.ts` files without a loader, so import it from a Worker or another bundled project, not from plain Node. (A host that compiles with plain `tsc` to a Node target would need its own step; Workers hosts do not.)

To use an unreleased commit, pin it: `bun add github:vikramrojo/cogens#<commit>`.

## Quick start

Define one owned type and read an entry back as its owner. You need [Bun](https://bun.sh) 1.4 or later.

```sh
mkdir hello && cd hello
bun init -y
bun add cogens
bun add -d miniflare @cloudflare/workers-types
```

Save as `hello.ts`:

```ts
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { contentType, createCms, field, type AccessContext, type Principal } from 'cogens';

// Your own kind of caller. The store never reads a cookie; you decide who is calling.
interface Member { kind: 'member'; id: string }

// An owned type: each row has an owner, and the rules say what an owner may do.
const note = contentType({
  id: 'note',
  name: 'Notes',
  displayField: 'title',
  owned: true,
  fields: {
    title: field.text('Title').required(),
    body: field.markdown('Body')
  },
  access(principal: Principal<Member>, { can }: AccessContext) {
    if (principal.kind === 'member') {
      can(['create', 'read', 'update', 'delete'], { where: { owner_id: principal.id } });
    }
  }
});

// An in-memory D1 with the package's migration applied (on Cloudflare, `wrangler d1 migrations apply` does this).
const mf = new Miniflare({ modules: true, script: 'export default {}', d1Databases: { DB: 'hello' } });
const db = (await mf.getD1Database('DB')) as unknown as D1Database;
const migration = readFileSync('node_modules/cogens/migrations/0001_entries.sql', 'utf8');
for (const statement of migration.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';')) {
  if (statement.trim()) await db.prepare(statement).run();
}

const cms = createCms<Member>({ db, types: [note], probes: [{ kind: 'member', id: 'probe' }] });

const ada: Member = { kind: 'member', id: 'ada' };
const bob: Member = { kind: 'member', id: 'bob' };

await cms.content.as(ada).create('note', { title: 'Hello', body: 'First **note**', owner_id: 'ada' });

console.log('ada sees', (await cms.content.as(ada).list('note')).map(n => n.data.title));
console.log('bob sees', (await cms.content.as(bob).list('note')).map(n => n.data.title));
await mf.dispose();
```

Run it:

```sh
bun run hello.ts
```

It prints `ada sees [ "Hello" ]` and `bob sees []`.

`probes` is one sample of each kind of caller you add. At startup the store runs every type's `access` against the built-in kinds and your probes and compiles what they grant, so a rule that cannot be turned into SQL stops the Worker before it serves a request.

The `examples/worker` folder in this repository is the same idea as a Worker: a `note` type, a `member` principal resolved from a session cookie, the admin at `/admin`, and two JSON routes. `bun test test/example.test.ts` runs it in Miniflare.

## Content types

```ts
contentType({
  id: 'article',                 // lowercase letter first; letters, digits, - and _
  name: 'Articles',
  displayField: 'title',
  owned: true,                 // entries have an owner_id; the type must then have `access`
  uniqueSlug: true,            // slug unique within the type (a partial unique index)
  indexed: ['visibility'],     // fields rules and `where` may name (see Migrations)
  parent: 'series',          // children of another type: parent_id, sort_key
  mirrors: ['status'],         // a child copies its parent's published state (below)
  access(principal, { can }) { /* ... */ },
  beforeWrite(ctx) { /* ... */ },
  afterWrite(ctx) { /* ... */ },
  fields: { title: field.text('Title').required().max(200), /* ... */ }
});
```

Field builders: `text`, `longText`, `markdown`, `url`, `email`, `boolean`, `number`, `date`, `select(label, { options })`, `ref(type, label)`, `refs(type, label)`, `files`, `json`. A field may be `.required()`, `.default(v)`, `.min(n)`, `.max(n)` and `.system()` (written only by a grant that lists it). Values are checked with `@cfworker/json-schema`; a bad value is a `ValidationError`.

An entry has the type's fields in `data` and these built-in columns: `id`, `owner_id`, `slug`, `status` (`draft` or `published`), `parent_id`, `sort_key`, `parent_status`, `created_at`, `updated_at`. Their names are reserved as field names.

## Principals and rules

A caller is a `Principal`: three built-in kinds and any you add.

```ts
import { admin, anonymous, system } from 'cogens';

admin();            // { kind: 'admin' }; the operator
anonymous;          // { kind: 'anonymous' }
system('job-name'); // background work, naming its job
// your own: { kind: 'member', id: 'ada' }, any object with a string `kind`
```

No kind has built-in power: the default is deny for everyone, the admin and `system` included. A type that should be open to the operator says so in its rules.

`access(principal, { can })` runs once per call to `content.as(principal)` and grants operations:

```ts
can('read', { where: { status: 'published', visibility: 'public' } });   // anyone
can('read', { bySlug: true, where: { status: 'published' } });           // a lookup by a slug the caller knows, not a list
can(['update', 'delete'], { where: { owner_id: principal.id }, fields: ['title', 'body'] });
can('create');                                                            // every row, every field
```

The operations are `create`, `read`, `update`, `delete` and `publish`. A `where` accepts equals, `in` (at most 90 values), `and` and `or`, over the built-in columns and the type's `indexed` fields; anything else throws when the store starts, not when a request arrives. `fields` limits what a create or update may write; a system field, `owner_id`, `slug`, `parent_id` or `sort_key`, is writable only when a grant lists it.

Each grant's `where` is compiled to a parameterised SQL condition, which the store ANDs into every `SELECT`, `UPDATE` and `DELETE`. CASL decides which fields are permitted; no export names a CASL type, so it can be replaced. Property tests compare the compiled SQL on a real D1 against CASL's in-memory answer for generated rows and rules.

```ts
const api = cms.content.as(principal);
await api.create('note', { title, owner_id });
await api.get('note', id);               // null when missing or not readable
await api.getBySlug('note', slug);
await api.list('note', { where: { f: 1 }, orderBy: 'created_at', direction: 'desc', limit: 50, offset: 0 });
await api.update('note', id, { title: 'New' });
await api.remove('note', id);
await api.publish('note', id);           // and unpublish
```

Refusals are typed: `Forbidden` (the caller may not), `ValidationError`, `Conflict`, `WriteRefused` (a hook refused), `TooManyEntries`, `TooManyChildren`, `ConfigError`, `ConditionError`.

### `updateEach`: several entries in one write

```ts
await api.updateEach('note', [
  { id: a, patch: { sort_key: '1' } },
  { id: b, patch: { sort_key: '2' } }
]);
```

All or nothing, in one D1 batch (one round trip): every row must be one the caller may update, each patch meets the rules `update` applies, and the hooks run per row. A row that moved out of reach between the read and the write fails the whole call as `Forbidden` and rolls the batch back. More than `maxUpdateEach` entries (500 by default) is `TooManyEntries`.

### Conditional update

```ts
const result = await api.update('note', id, { rev: 5 }, { when: { rev: { lt: 5 } } });
if (!result.applied) { /* result.reason === 'precondition' */ }
```

`when` takes `{ field: { equals | lt | gt | isNull } }` and `{ or: [...] }`, compiled into the same `WHERE` as the access condition and checked in the same statement, so two racing writers leave the higher value. It reports whether it applied.

### Mirrors

A type with `parent` and `mirrors: ['status']` copies its parent's status into `parent_status`. Publishing or unpublishing the parent runs as one `db.batch` (the parent, then one `UPDATE ... WHERE parent_id = ?` for all children), so a rule on `parent_status` makes the children readable the moment the parent is published. `maxMirrorChildren` (10,000 by default) caps the children one publish may change, checked before the batch.

### Hooks

`beforeWrite(ctx)` and `afterWrite(ctx)` get `{ operation, type, principal, existing, input, content }` (`afterWrite` also gets `entry`). `ctx.content` is the store as the same caller. `ctx.refuse('message')` in `beforeWrite` stops the write with `WriteRefused`; nothing is stored. Use hooks for what rules cannot see, such as a value being written.

### The public read API is off by default

`cms.publicApi` is a Hono app answering `GET /:type` and `GET /:type/:slugOrId`, as the `anonymous` caller, for the types named in `publicTypes`; with none named every route is a 404. Mount it where you like:

```ts
const cms = createCms({ db, types, publicTypes: ['page'] });
app.route('/api/content', cms.publicApi);
```

It answers only what the type's rules let an anonymous caller read.

### Media

Pass `media: { bucket, access }` to `createCms` for upload, list and delete through `cms.media.as(principal)`, with an `access` function of its own over `owner_id` and `id`, and a size cap (`maxBytes`, 10 MB). With no `media` option there is none.

### External collections and service types

A type declared `service: { readOnly: true }` is never stored in `entries`: it names a table of your own so the admin can show it (below).

## The policy matrix

`policyMatrix` (from `cogens` or `cogens/testing`) is for your own tests. Name sample callers and what each should be able to do on each type; it asserts every operation on every type (anything unlisted must be denied) and that the rules packed for the browser (`cms.access.rulesFor`) agree with what the engine enforces, row by row.

```ts
import { policyMatrix } from 'cogens/testing';

policyMatrix({
  cms,
  callers: { ada: { kind: 'member', id: 'ada' }, anon: anonymous },
  expect: { ada: { note: ['create', 'read', 'lookup', 'update', 'delete'] }, anon: {} },
  rows: { note: [{ owner_id: 'ada' }, { owner_id: 'bob' }] }
});
```

It uses no test framework; it throws `PolicyMismatch` naming each caller, type and operation that disagrees. `lookup` is a read by slug.

## The admin

```ts
import { createAdmin } from 'cogens/admin';

const host = new Hono().route('/admin', createAdmin({
  cms,
  resolvePrincipal: c => /* your Principal, or null */,
  mount: '/admin',
  siteName: 'My site',
  session                      // optional: draws a sign-in page and the sign-out forms
}));
```

The pages (type list, entry list, entry view and edit, delete confirmation, external collection list and row) are Hono routes rendered with `hono/html`. The admin is an ordinary client of `content.as(principal)` for the principal you resolve, so it can do nothing the type's rules refuse that caller; it offers a button only if `cms.access.rulesFor` says the caller may press it. Writes are forms that POST and redirect with 303, refused unless they come from the admin's own origin (`hono/csrf`), under a content security policy (`hono/secure-headers`).

Options: `externalCollections` (read-only views over your own tables, with `list`, `get`, `actions` and `allow`), `typeActions` (extra buttons on a type's entries; an action with the id `unpublish` or `delete` replaces the page's own), `session` (`{ signIn, signOut, signOutEverywhere }` as functions that answer a `Response`), `unauthorized` (what to answer when there is no principal and no `session`), and `assets`.

Static files the admin links, which your Worker serves (default URLs in `DEFAULT_ASSETS`): Largen's `largen.css` and `largen-theme-dark.css` (the `largen` package; without them the pages are plain HTML), and the markdown editor: `admin-editor.js`, `admin-editor.css` and `admin-editor-dark.css`. The admin's own script and style are served by the admin itself at `<mount>/assets/`. If the editor does not load, a markdown field is a plain textarea.

Build the editor into your static folder (it needs `@milkdown/crepe`, an optional peer dependency):

```sh
bun add -d @milkdown/crepe
bun run node_modules/cogens/scripts/build-admin-editor.ts public
```

It writes `admin-editor.js`, `admin-editor.css`, `admin-editor-dark.css` and `admin-editor.LICENSES.txt`, the licence texts of the packages bundled (the module's banner names it; serve it beside the module). The editor has no syntax of its own beyond markdown; a host adds its own with a plugin module.

### Editor plugins

`build-admin-editor.ts <outDir> --plugins <module>` bundles a host file into the editor. The module's default export is a function `(builder, context) => void | Promise<void>`. It is called once per editor with Crepe's builder (`builder.editor` is the Milkdown editor) and `context = { type, field }`, the content type id and the field name of the text area, before the editor is created, so it can add remark plugins, nodes and node views. The admin renders each markdown text area with `data-type` and `data-field` for this. A plugin's syntax applies to every markdown field unless it checks the context: a plugin that ignores the second argument keeps working, and an ordinary field's text is saved unchanged only if the syntax was not added to it.

`--plugins` paths resolve from the current working directory, not from the build script or the package. The module imports its own Milkdown packages (and any remark plugin) from the host's `node_modules`, so add them to the host (`bun add -d @milkdown/kit remark-directive`). Without `--plugins` the bundle contains none of this.

For example, `:mention[ada]` as a chip that saves as the same text:

```js
// editor-plugin.js
import { remarkPluginsCtx } from '@milkdown/kit/core';
import { $node } from '@milkdown/kit/utils';
import remarkDirective from 'remark-directive';

const labelOf = node => (node.children || []).map(c => c.value ?? '').join('');

const mention = $node('mention', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { name: { default: '' } },
  parseDOM: [{ tag: 'span[data-mention]', getAttrs: dom => ({ name: dom.getAttribute('data-mention') }) }],
  toDOM: node => ['span', { 'data-mention': node.attrs.name, contenteditable: 'false' }, `@${node.attrs.name}`],
  parseMarkdown: {
    match: node => node.type === 'textDirective' && node.name === 'mention',
    runner: (state, node, type) => { state.addNode(type, { name: labelOf(node) }); }
  },
  toMarkdown: {
    match: node => node.type.name === 'mention',
    runner: (state, node) => { state.addNode('textDirective', [{ type: 'text', value: node.attrs.name }], undefined, { name: 'mention', attributes: {} }); }
  }
}));

export default function (builder, context) {
  // Only the `note` type's `body` field has mentions; any other field keeps its text exactly as stored.
  if (context.type !== 'note' || context.field !== 'body') return;
  builder.editor
    .config(ctx => ctx.update(remarkPluginsCtx, plugins => [...plugins, { plugin: remarkDirective, options: {} }]))
    .use(mention);
}
```

```sh
bun run node_modules/cogens/scripts/build-admin-editor.ts public --plugins ./editor-plugin.js
```

`remark-directive` also reads any other `:word` in prose as a directive, so a real plugin should turn the ones it does not own back into text, as `test/fixtures/mention-plugin.js` does. The editor module's `createEditor` returns `{ getMarkdown, editor }`.

## The auth package

```ts
import {
  createPrincipalResolver, passwordRoutes, createSession, readSession, endSession, revokeSessions,
  mintHandoffToken, exchangeHandoffToken, purgeExpiredSessions, purgeExpiredHandoffTokens, sha256Hex
} from 'cogens/auth';
```

- **Sessions** are rows in `sessions` named by a signed cookie that holds only a random id. A row says whose session it is (`ownerId`, an opaque string, null for the operator), its `kind` (`admin`, or whatever you call it), its `method` (`password`, `handoff`) and when it ends. The signing key is at least 32 characters and is never a password. `revokeSessions(db, { ownerId, kind })` signs out everywhere and refuses to run with neither.
- **Handoff tokens** start a session somewhere else (an app, an email link) and give it to a browser: `mintHandoffToken(db, { ownerId, lifetimeSeconds })` returns the raw token once, only its SHA-256 is stored, and `exchangeHandoffToken(c, db, config, token, kind)` deletes the row with `DELETE ... RETURNING`, so a token starts at most one session even when two requests arrive together.
- **The operator's password sign-in** is `passwordRoutes()`, Hono routes to mount at `/api/auth` (`POST /login`, `/logout`, `/logout-all`, `GET /me`). The cookie is signed with its own key, the password is compared as fixed-length digests, failed attempts per `CF-Connecting-IP` are limited (5 in 15 minutes) through `auth_attempts`, and sign-out-everywhere deletes every `admin` session row. Defaults carried over from Koguma, all overridable in `PasswordOptions`: cookie `koguma_session`, env bindings `KOGUMA_SECRET` (the password), `KOGUMA_SESSION_KEY` (the signing key) and `DB`.
- **`createPrincipalResolver`** is the one function that learns who a request is: an admin session gives `{ kind: 'admin' }`; a session of another kind goes through your `SessionSource` (`config(env)` gives the cookie and key, `principal(session, env)` your principal or null); anything else is null, and you decide anonymous or 401.

The package never learns what an owner is. It imports neither core nor admin.

## Testing with a database

`createTestDb` (from `cogens/testing`) starts a Miniflare D1 and R2 bucket, applies the package's own migrations (`0001_entries.sql`, `auth/0001_sessions.sql`) and then each SQL file you list (paths from the working directory), and returns `{ db, r2, dispose }`. Miniflare is an optional peer dependency, imported only when the function runs: `bun add -d miniflare`.

```ts
import { createTestDb } from 'cogens/testing';
import { migrationLines } from 'cogens/migrations-tool';

const t = await createTestDb({ migrations: ['migrations/0002_my_types.sql'] });
const cms = createCms({ config, db: t.db });
// ...
await t.dispose();
```

`migrationLines(types)` returns the SQL lines `cogens-print-migration` prints for a list of content types, so a test can compare them with your migration file. The scripts also resolve by name: `cogens/scripts/print-migration.ts`.

## Migrations

SQL files a host applies, in this order (copy them into your Wrangler `migrations_dir` under numbers that fit, as `examples/worker/migrations` does, or run them with `wrangler d1 execute`):

1. `migrations/0001_entries.sql`: `entries` (Koguma's columns plus `owner_id`, `parent_id`, `sort_key`, `parent_status`), `assets` (plus `owner_id`) and their indexes.
2. `migrations/auth/0001_sessions.sql`, only if you import `cogens/auth`: `sessions`, `handoff_tokens`, `identities`, `auth_attempts`, `auth_meta`.
3. The lines for your own types' indexed fields, which `print-migration` prints for your config.

A rule or `where` may name only the built-in columns and a type's `indexed` fields; an indexed field is a virtual generated column over the entry's JSON (SQLite's `ALTER TABLE ADD COLUMN` allows only virtual ones, and they can be indexed), plus a partial unique index on `(content_type, slug)` for types with `uniqueSlug`. Print them from a config file whose default export is `{ contentTypes }` (what `defineConfig` returns):

```sh
bunx cogens-print-migration site.config.ts
```

Put the printed lines in a migration of your own. At startup, on first use, the store compares them with `PRAGMA table_xinfo(entries)` and fails naming the type and field if one is missing.

**A database that already has Koguma's `entries` and `assets`** (its own `0001`) must not apply `0001_entries.sql`, whose `CREATE TABLE IF NOT EXISTS` would skip the tables and leave the new columns missing. Apply `migrations/koguma-upgrade.sql` instead, which adds the four columns, `assets.owner_id` and the indexes. A host that already added those columns itself skips both. The auth tables are independent of either. Nothing in these files names any host's tables.

## The import boundary

- `cogens` (core) imports `hono`, `@casl/ability` and `@cfworker/json-schema` and nothing else.
- `cogens/admin` imports core and `hono`.
- `cogens/auth` imports `hono` only.
- Only files under `src/core/store` import `src/core/store/sql.ts`, the one file that names the tables holding entries and assets, so a query without an access decision cannot be written from outside.
- Plain folders under `src/`, no workspaces. Your Worker's bundle includes only the entry points you import.

## Development

```sh
bun install
bun test            # the package's tests, the example Worker in Miniflare included
bun run typecheck   # src, the example, the scripts
```

## Contributing

Issues are welcome: bug reports, questions, and notes on where the access rules or the docs surprised you. Pull requests are welcome by arrangement: open an issue first to agree the change, since the package is small on purpose (see the import boundary above). Run `bun test` and `bun run typecheck` before sending anything.

## Security

Please report a vulnerability privately through GitHub's private vulnerability reporting (the Security tab of this repository, "Report a vulnerability"), not in a public issue. The access engine and the session code are the parts where a flaw matters most.

## Licence

MIT. Copyright (c) 2026 Matthew Eric Goodwin (Koguma) and Vikram Rojo. See `LICENSE` and `NOTICE`.
