/**
 * The policy test helper. A host lists its sample callers and what each should
 * be able to do on each type; the helper asserts every operation on every type
 * (an operation not listed must be denied) and that the rules packed for display
 * agree with what the engine enforces. It uses no test framework: it throws
 * `PolicyMismatch`, which any runner reports with the message.
 */
import { RuleSet } from '../access/ability.ts';
import { OPERATIONS, runAccess } from '../access/can.ts';
import { permits, type PackedRules } from '../access/permits.ts';
import type { Operation } from '../errors.ts';
import type { HostPrincipal, Principal } from '../principal.ts';
import type { Cms } from '../store/cms.ts';

/** The operations a caller has on a type (on at least one row), or a map where a missing operation is denied. */
export type Expectation = readonly (Operation | 'lookup')[] | Partial<Record<Operation | 'lookup', boolean>>;

export interface PolicyMatrixOptions<H extends HostPrincipal = never> {
  cms: Cms<H>;
  /** Sample callers by name. */
  callers: Record<string, Principal<H>>;
  /** For each caller, for each type: what it may do. A caller or type left out may do nothing. `lookup` is a read by slug. */
  expect: Record<string, Record<string, Expectation>>;
  /**
   * Sample rows per type, as the rules see a row (the built-in columns and the indexed fields), to check that the
   * packed rules and the engine give the same answer row by row.
   */
  rows?: Record<string, Record<string, unknown>[]>;
  /** The packed rules to test against enforcement; `cms.access.rulesFor` when absent. */
  rules?: (principal: Principal<H>) => PackedRules;
}

export class PolicyMismatch extends Error {
  override readonly name = 'PolicyMismatch';
  constructor(readonly failures: string[]) {
    super(`${failures.length} policy mismatch${failures.length === 1 ? '' : 'es'}:\n${failures.map(f => `  ${f}`).join('\n')}`);
  }
}

const ALL: readonly (Operation | 'lookup')[] = [...OPERATIONS, 'lookup'];

function wanted(expectation: Expectation | undefined, operation: Operation | 'lookup'): boolean {
  if (expectation === undefined) return false;
  if (Array.isArray(expectation)) return (expectation as readonly string[]).includes(operation);
  return (expectation as Partial<Record<string, boolean>>)[operation] === true;
}

export function policyMatrix<H extends HostPrincipal = never>(options: PolicyMatrixOptions<H>): void {
  const failures: string[] = [];
  for (const [name, principal] of Object.entries(options.callers)) {
    const packed = (options.rules ?? options.cms.access.rulesFor)(principal);
    for (const type of options.cms.types.values()) {
      if (type.service) continue;
      const rules = new RuleSet(type.id, type.access ? runAccess(type.access, principal) : []);
      const expectation = options.expect[name]?.[type.id];
      for (const operation of ALL) {
        const enforced = operation === 'lookup' ? rules.has('read') || rules.has('lookup') : rules.has(operation);
        const shown = permits(packed, type.id, operation);
        const expected = wanted(expectation, operation);
        const where = `${name} / ${type.id} / ${operation}`;
        if (enforced !== expected) failures.push(`${where}: expected ${expected ? 'allowed' : 'denied'}, the rules ${enforced ? 'allow' : 'deny'} it`);
        if (shown !== enforced) failures.push(`${where}: the packed rules ${shown ? 'allow' : 'deny'} it, enforcement ${enforced ? 'allows' : 'denies'} it`);
        for (const row of options.rows?.[type.id] ?? []) {
          if (operation === 'lookup') continue;
          const rowEnforced = rules.allows(operation, row);
          const rowShown = permits(packed, type.id, operation, row);
          if (rowEnforced !== rowShown) {
            failures.push(`${where} on row ${JSON.stringify(row)}: the packed rules ${rowShown ? 'allow' : 'deny'} it, enforcement ${rowEnforced ? 'allows' : 'denies'} it`);
          }
        }
      }
    }
  }
  if (failures.length > 0) throw new PolicyMismatch(failures);
}
