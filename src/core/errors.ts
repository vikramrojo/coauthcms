/** The typed errors the store throws. A read the caller may not make never throws; it answers null or an empty list. */

export type Operation = 'create' | 'read' | 'update' | 'delete' | 'publish';

/** A write the caller's rules refuse. `field` is set when a field rule caused it. */
export class Forbidden extends Error {
  override readonly name = 'Forbidden';
  constructor(
    readonly operation: Operation | 'unpublish',
    readonly type: string,
    readonly field?: string
  ) {
    super(
      field === undefined
        ? `Forbidden: ${operation} on ${type}.`
        : `Forbidden: ${operation} on ${type} may not write the field "${field}".`
    );
  }
}

/** The host's configuration is wrong; the message names the type and, where there is one, the field. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly type?: string,
    readonly field?: string
  ) {
    super(message);
  }
}

/** A condition the compiler refuses: an unknown operator, a field that is not indexed, or too many values. */
export class ConditionError extends Error {
  override readonly name = 'ConditionError';
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message);
  }
}

/** The data does not fit the type's fields, or names a field the type does not have. */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(
    readonly type: string,
    readonly issues: { field: string; message: string }[]
  ) {
    super(`Invalid ${type}: ${issues.map(i => `${i.field}: ${i.message}`).join('; ')}`);
  }
}

/** A before-write hook refused the write. */
export class WriteRefused extends Error {
  override readonly name = 'WriteRefused';
  constructor(
    readonly type: string,
    message: string
  ) {
    super(message);
  }
}

/** A unique constraint (the id, or a unique slug) was already taken. */
export class Conflict extends Error {
  override readonly name = 'Conflict';
  constructor(
    readonly type: string,
    readonly field: 'id' | 'slug'
  ) {
    super(`Conflict: a ${type} with this ${field} already exists.`);
  }
}

/** Publishing a parent would update more children than one atomic write may. */
export class TooManyChildren extends Error {
  override readonly name = 'TooManyChildren';
  constructor(
    readonly type: string,
    readonly count: number,
    readonly limit: number
  ) {
    super(`${type} has ${count} children that mirror its status; the limit for one write is ${limit}. Nothing was changed.`);
  }
}

/** A bulk write names more entries than one write may hold. */
export class TooManyEntries extends Error {
  override readonly name = 'TooManyEntries';
  constructor(
    readonly type: string,
    readonly count: number,
    readonly limit: number
  ) {
    super(`${count} ${type} entries in one write; the limit is ${limit}. Nothing was changed.`);
  }
}
