/**
 * The `can` builder a type's access function calls to grant operations. It
 * records plain grants (`Grant`) and nothing else, so no type exposes the engine
 * under it; ability.ts turns the grants into the engine's rules.
 *
 *   access(principal, { can }) {
 *     can('read', { where: { status: 'published' } });
 *     if (principal.kind === 'composer') can(['update', 'delete'], { where: { owner_id: principal.ownerId } });
 *   }
 */
import { ConditionError, type Operation } from '../errors.ts';
import { walkWhere, type Where } from './where.ts';

export const OPERATIONS: readonly Operation[] = ['create', 'read', 'update', 'delete', 'publish'];

export interface GrantOptions {
  /** Confines the grant to rows that match. Absent means every row of the type. */
  where?: Where;
  /**
   * The fields the grant lets the caller write (create and update), by name. Absent means every field that is not
   * a system field. A system field, `owner_id`, `slug`, `parent_id` or `sort_key` is writable only when listed here.
   */
  fields?: readonly string[];
  /**
   * Read only: the grant applies to a lookup by slug and not to a list or a get by id, so a type can let a caller
   * read an entry whose slug it knows without letting it list that entry.
   */
  bySlug?: boolean;
}

/** One grant, as recorded; also what `cms.access.rulesFor` hands a page. */
export interface Grant {
  operation: Operation;
  where?: Where;
  fields?: string[];
  bySlug?: boolean;
}

export type Can = (operation: Operation | readonly Operation[], options?: GrantOptions) => void;

export interface AccessContext {
  can: Can;
}

export type AccessFn<P = unknown> = (principal: P, context: AccessContext) => void;

export function runAccess<P>(access: AccessFn<P>, principal: P): Grant[] {
  const grants: Grant[] = [];
  const can: Can = (operation, options = {}) => {
    const operations = Array.isArray(operation) ? operation : [operation as Operation];
    if (operations.length === 0) throw new ConditionError('`can` needs at least one operation.');
    for (const op of operations) {
      if (!OPERATIONS.includes(op)) throw new ConditionError(`Unknown operation "${String(op)}".`);
      if (options.bySlug && op !== 'read') throw new ConditionError('`bySlug` applies to read only.');
      if (options.where !== undefined) walkWhere(options.where, () => {});
      grants.push({
        operation: op,
        ...(options.where === undefined ? {} : { where: options.where }),
        ...(options.fields === undefined ? {} : { fields: [...options.fields] }),
        ...(options.bySlug ? { bySlug: true } : {})
      });
    }
  };
  access(principal, { can });
  return grants;
}
