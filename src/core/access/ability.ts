/**
 * The decision engine: grants in, answers about one row out. This is the only
 * file that imports CASL, and nothing here is exported by the package's index:
 * a host sees `RuleSet`, whose methods take and return plain values.
 */
import { createMongoAbility, mongoQueryMatcher, subject, type ConditionsMatcher, type MongoAbility, type RawRuleOf } from '@casl/ability';
import { permittedFieldsOf } from '@casl/ability/extra';
import type { Operation } from '../errors.ts';
import type { Grant } from './can.ts';
import { toMongo } from './where.ts';

/** Stands for "every field that is not a system field" in a grant with no field list. */
const ORDINARY = '*';

/** A row as rules see it: the built-in columns and the values of the indexed fields. */
export type RuleRow = Record<string, unknown>;

type Rule = RawRuleOf<MongoAbility>;

type Match = (row: Record<string, unknown>) => boolean;

/**
 * CASL's matcher knows equals and `$in` but not `$and` or `$or`, so those two are
 * handled here and everything under them (the equals and `in` leaves) is still
 * decided by CASL's own matcher.
 */
const conditionsMatcher: ConditionsMatcher<any> = conditions => {
  const compile = (c: Record<string, unknown>): Match => {
    if ('$and' in c) {
      const parts = (c.$and as Record<string, unknown>[]).map(compile);
      return row => parts.every(p => p(row));
    }
    if ('$or' in c) {
      const parts = (c.$or as Record<string, unknown>[]).map(compile);
      return row => parts.some(p => p(row));
    }
    return mongoQueryMatcher(c as never) as Match;
  };
  return compile(conditions);
};

export interface PermittedFields {
  /** The grants that match the row allow every ordinary field. */
  ordinary: boolean;
  /** Fields a matching grant lists by name (these may be system fields). */
  listed: Set<string>;
}

export class RuleSet {
  private readonly ability: MongoAbility;

  constructor(
    readonly type: string,
    readonly grants: readonly Grant[]
  ) {
    const rules: Rule[] = grants.map(g => ({
      action: g.bySlug ? 'lookup' : g.operation,
      subject: type,
      ...(g.where === undefined ? {} : { conditions: toMongo(g.where) }),
      fields: g.fields ?? [ORDINARY]
    }));
    this.ability = createMongoAbility(rules, { conditionsMatcher });
  }

  /** Whether any grant gives the operation, whatever the row. */
  has(operation: Operation | 'lookup'): boolean {
    return this.ability.rulesFor(operation, this.type).length > 0;
  }

  /** Whether a grant for the operation matches this row. */
  allows(operation: Operation, row: RuleRow): boolean {
    return this.ability.can(operation, subject(this.type, { ...row }));
  }

  /** A lookup by slug is answered by the read grants and the by-slug ones. */
  allowsLookup(row: RuleRow): boolean {
    return this.allows('read', row) || this.ability.can('lookup', subject(this.type, { ...row }));
  }

  permittedFields(operation: Operation, row: RuleRow): PermittedFields {
    const fields = permittedFieldsOf(this.ability, operation, subject(this.type, { ...row }), {
      fieldsFrom: rule => rule.fields ?? [ORDINARY]
    });
    return { ordinary: fields.includes(ORDINARY), listed: new Set(fields.filter(f => f !== ORDINARY)) };
  }
}
