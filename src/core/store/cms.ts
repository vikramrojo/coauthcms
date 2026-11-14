/**
 * createCms: checks a host's types and hands back the store. Rules are compiled
 * once at startup against a probe of each kind of caller, so a condition on a
 * field that is not indexed, or a missing access function, stops the Worker
 * before any request is served; the database's columns are checked on first use.
 */
import { Hono } from 'hono';
import { compileAny } from '../access/compile.ts';
import { runAccess } from '../access/can.ts';
import { pack, type PackedRules } from '../access/permits.ts';
import type { ContentType } from '../config/define.ts';
import { ADDED_COLUMNS, indexedColumn } from '../columns.ts';
import { ConditionError, ConfigError } from '../errors.ts';
import { createMedia, type MediaApi, type MediaOptions } from '../media/index.ts';
import { admin, anonymous, assertPrincipal, system, type HostPrincipal, type Principal } from '../principal.ts';
import { columnOf, Content, type Internals } from './content.ts';
import { entryColumns } from './sql.ts';
import type { ContentApi, Entry } from './types.ts';

export interface CmsOptions<H extends HostPrincipal = never> {
  db: D1Database;
  types: ContentType<any>[];
  /**
   * One sample principal of each kind the host adds. Startup runs every type's access function against these and
   * the built-in kinds and compiles what they grant, so a rule that cannot compile fails at startup.
   */
  probes?: H[];
  /** Assets: files in R2 with a row each, under an access function of their own. Off when absent. */
  media?: MediaOptions;
  /**
   * The types the public read API answers for, as an anonymous caller. Off when absent or empty: every public content
   * route is then not found.
   */
  publicTypes?: string[];
  /** The most children whose mirrored status one publish may change; 10,000 when absent. */
  maxMirrorChildren?: number;
  /** The most entries one `updateEach` may name; 500 when absent. */
  maxUpdateEach?: number;
  newId?: () => string;
}

export interface Cms<H extends HostPrincipal = never> {
  readonly types: ReadonlyMap<string, ContentType<any>>;
  readonly content: { as(principal: Principal<H>): ContentApi };
  readonly access: {
    /** The grants that apply to a caller, as plain JSON for a page to show or hide controls with. Not what enforces access. */
    rulesFor(principal: Principal<H>): PackedRules;
  };
  /** Present when `media` was given. */
  readonly media: { as(principal: Principal<H>): MediaApi } | null;
  /** The public read API as a Hono app, for the host to mount where it likes. */
  readonly publicApi: Hono;
  /** Checks that the database has every column the types need; rejects naming the type and field. Every operation awaits it. */
  verify(): Promise<void>;
}

export function createCms<H extends HostPrincipal = never>(options: CmsOptions<H>): Cms<H> {
  const types = new Map<string, ContentType<any>>();
  for (const type of options.types) {
    if (types.has(type.id)) throw new ConfigError(`Type "${type.id}" is defined twice.`, type.id);
    types.set(type.id, type);
  }
  const probes: HostPrincipal[] = [admin(), system('startup-probe'), anonymous, ...(options.probes ?? [])];
  for (const probe of probes) assertPrincipal(probe);

  for (const type of types.values()) {
    if (type.parent !== undefined && !types.has(type.parent)) {
      throw new ConfigError(`Type "${type.id}" names the parent type "${type.parent}", which is not defined.`, type.id);
    }
    if (type.service) continue;
    if (type.owned && !type.access) {
      throw new ConfigError(`Type "${type.id}" is owned and has no access function; an owned type must say who may do what.`, type.id);
    }
    if (!type.access) continue;
    for (const probe of probes) {
      try {
        const grants = runAccess(type.access, probe);
        for (const grant of grants) compileAny([grant.where], columnOf(type));
        for (const grant of grants) {
          for (const name of grant.fields ?? []) {
            if (!(name in type.fields) && !['owner_id', 'slug', 'parent_id', 'sort_key'].includes(name)) {
              throw new ConfigError(`Type "${type.id}" grants the field "${name}", which it does not have.`, type.id, name);
            }
          }
        }
      } catch (error) {
        if (error instanceof ConditionError) {
          throw new ConfigError(
            `Type "${type.id}": ${error.message}${error.field ? ` Index it with indexed: ['${error.field}'] if it is a field.` : ''}`,
            type.id,
            error.field
          );
        }
        throw error;
      }
    }
  }
  const publicTypes = options.publicTypes ?? [];
  for (const id of publicTypes) {
    const type = types.get(id);
    if (!type || type.service) throw new ConfigError(`The public API names the type "${id}", which is not a stored type.`, id);
  }

  let verified: Promise<void> | null = null;
  const verify = () => {
    verified ??= check(options.db, [...types.values()]).catch(error => {
      verified = null;
      throw error;
    });
    return verified;
  };

  const internals: Internals = {
    db: options.db,
    types,
    maxMirrorChildren: options.maxMirrorChildren ?? 10_000,
    maxUpdateEach: options.maxUpdateEach ?? 500,
    newId: options.newId ?? (() => crypto.randomUUID()),
    ensureReady: verify
  };

  const content = {
    as(principal: Principal<H>): ContentApi {
      assertPrincipal(principal);
      return new Content(internals, principal as Principal<HostPrincipal>);
    }
  };

  const media = options.media ? createMedia(options.db, options.media, verify) : null;

  return {
    types,
    content,
    access: {
      rulesFor(principal) {
        assertPrincipal(principal);
        return [...types.values()]
          .filter(type => !type.service)
          .map(type => pack(type.id, type.access ? runAccess(type.access, principal) : []));
      }
    },
    media: media && {
      as(principal) {
        assertPrincipal(principal);
        return media.as(principal as Principal<HostPrincipal>);
      }
    },
    publicApi: publicApi(content, types, publicTypes),
    verify
  };
}

async function check(db: D1Database, types: ContentType<any>[]): Promise<void> {
  const columns = new Map((await entryColumns(db)).map(c => [c.name, c.hidden]));
  for (const name of ADDED_COLUMNS) {
    if (!columns.has(name)) throw new ConfigError(`The entries table has no column "${name}". Apply cogens's migrations/0001_entries.sql (or koguma-upgrade.sql on a Koguma database).`, undefined, name);
  }
  for (const type of types) {
    if (type.service) continue;
    for (const field of type.indexed) {
      if (!columns.has(indexedColumn(field))) {
        throw new ConfigError(
          `Type "${type.id}" indexes "${field}", but the entries table has no column "${indexedColumn(field)}". Print the lines to apply with cogens-print-migration.`,
          type.id,
          field
        );
      }
    }
  }
}

const SINGLE = (e: Entry) => ({ id: e.id, slug: e.slug, created_at: e.created_at, updated_at: e.updated_at, ...e.data });

/** Off unless a type is named; then it answers only what the type's rules let an anonymous caller read. */
function publicApi(content: { as(principal: Principal<never>): ContentApi }, types: ReadonlyMap<string, ContentType<any>>, enabled: string[]): Hono {
  const app = new Hono();
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json({ error: 'not_found' }, 404);
  app.get('/:type', async c => {
    const id = c.req.param('type');
    if (!enabled.includes(id) || !types.has(id)) return notFound(c);
    const limit = Number(c.req.query('limit') ?? 100);
    const offset = Number(c.req.query('offset') ?? 0);
    const entries = await content.as(anonymous).list(id, {
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0
    });
    return c.json({ entries: entries.map(SINGLE) });
  });
  app.get('/:type/:key', async c => {
    const id = c.req.param('type');
    if (!enabled.includes(id) || !types.has(id)) return notFound(c);
    const api = content.as(anonymous);
    const key = c.req.param('key');
    const entry = (await api.getBySlug(id, key)) ?? (await api.get(id, key));
    return entry ? c.json(SINGLE(entry)) : notFound(c);
  });
  app.all('*', c => c.json({ error: 'not_found' }, 404));
  return app;
}
