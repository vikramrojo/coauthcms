/**
 * Media, reduced to upload, list and delete, each through the same access check
 * as an entry: a host passes an `access` function for assets (the operations
 * create, read and delete, conditions over `owner_id` and `id`), and with none a
 * caller can do nothing. Files live in R2; the row holds the name, type and size.
 */
import { compileAny, type ColumnOf } from '../access/compile.ts';
import { RuleSet } from '../access/ability.ts';
import { runAccess, type AccessFn } from '../access/can.ts';
import { ConditionError, Forbidden, ValidationError } from '../errors.ts';
import type { HostPrincipal, Principal } from '../principal.ts';
import { deleteAsset, insertAsset, selectAssets } from '../store/assets.ts';

export interface MediaOptions {
  bucket: R2Bucket;
  /** Who may create, read and delete assets. */
  access: AccessFn<any>;
  /** Largest upload, in bytes; 10 MB when absent. */
  maxBytes?: number;
  newId?: () => string;
}

export interface Asset {
  id: string;
  owner_id: string | null;
  name: string;
  content_type: string;
  size: number;
  /** The R2 key the file is stored under. */
  key: string;
  created_at: string;
}

export interface UploadInput {
  name: string;
  contentType: string;
  body: ArrayBuffer | Uint8Array | Blob;
  ownerId?: string | null;
}

export interface MediaApi {
  upload(input: UploadInput): Promise<Asset>;
  list(): Promise<Asset[]>;
  get(id: string): Promise<Asset | null>;
  remove(id: string): Promise<void>;
}

const TYPE = 'asset';
const columnOf: ColumnOf = field => (field === 'owner_id' || field === 'id' ? field : null);
const DEFAULT_MAX = 10 * 1024 * 1024;

export function createMedia(db: D1Database, options: MediaOptions, ensureReady: () => Promise<void>) {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;

  /** Assets answer to the same engine, as a type named `asset` with no fields of its own. */
  function as(principal: Principal<HostPrincipal>): MediaApi {
    const rules = new RuleSet(TYPE, runAccess(options.access, principal));
    const condition = (operation: 'create' | 'read' | 'delete') => {
      try {
        const compiled = compileAny(rules.grants.filter(g => g.operation === operation).map(g => g.where), columnOf);
        return compiled && { sql: `(${compiled.sql})`, params: compiled.params };
      } catch (error) {
        if (error instanceof ConditionError) throw new ConditionError(`Media: ${error.message}`, error.field);
        throw error;
      }
    };
    const toAsset = (row: Awaited<ReturnType<typeof selectAssets>>[number]): Asset => ({
      id: row.id,
      owner_id: row.owner_id,
      name: String(row.data.name ?? ''),
      content_type: String(row.data.content_type ?? ''),
      size: Number(row.data.size ?? 0),
      key: String(row.data.key ?? ''),
      created_at: row.created_at
    });

    return {
      async upload(input) {
        const ownerId = input.ownerId ?? null;
        if (!rules.allows('create', { owner_id: ownerId })) throw new Forbidden('create', TYPE);
        const bytes = input.body instanceof Blob ? await input.body.arrayBuffer() : input.body;
        if (bytes.byteLength > maxBytes) {
          throw new ValidationError(TYPE, [{ field: 'body', message: `is ${bytes.byteLength} bytes; the limit is ${maxBytes}.` }]);
        }
        if (input.name.trim() === '') throw new ValidationError(TYPE, [{ field: 'name', message: 'is required.' }]);
        await ensureReady();
        const id = newId();
        const key = `media/${id}`;
        await options.bucket.put(key, bytes, { httpMetadata: { contentType: input.contentType } });
        try {
          await insertAsset(db, {
            id,
            owner_id: ownerId,
            data: { name: input.name, content_type: input.contentType, size: bytes.byteLength, key }
          }).run();
        } catch (error) {
          await options.bucket.delete(key);
          throw error;
        }
        return toAsset((await selectAssets(db, { sql: '1', params: [] }, id))[0]!);
      },

      async list() {
        const access = condition('read');
        if (!access) return [];
        await ensureReady();
        return (await selectAssets(db, access)).map(toAsset);
      },

      async get(id) {
        const access = condition('read');
        if (!access) return null;
        await ensureReady();
        const row = (await selectAssets(db, access, id))[0];
        return row ? toAsset(row) : null;
      },

      async remove(id) {
        const access = condition('delete');
        if (!access) throw new Forbidden('delete', TYPE);
        await ensureReady();
        const row = (await selectAssets(db, access, id))[0];
        if (!row) throw new Forbidden('delete', TYPE);
        await deleteAsset(db, id, access).run();
        await options.bucket.delete(String(row.data.key ?? `media/${id}`));
      }
    };
  }

  return { as };
}
