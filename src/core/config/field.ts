/**
 * field.* builders: the content fields of a type. Each holds its label, its kind
 * for the admin and a JSON Schema (draft 7) for @cfworker/json-schema, which
 * validates without `new Function`, so it runs in a Worker.
 *
 *   field.text('Title').required().max(100)
 *   field.number('Revision').system()
 */
import type { Schema } from '@cfworker/json-schema';

export type FieldType =
  | 'text'
  | 'longText'
  | 'markdown'
  | 'url'
  | 'email'
  | 'boolean'
  | 'number'
  | 'date'
  | 'select'
  | 'reference'
  | 'references'
  | 'files'
  | 'json';

export interface FieldMeta {
  label: string;
  fieldType: FieldType;
  required: boolean;
  /** A system field is writable only by a caller whose rule lists it by name. */
  system: boolean;
  refContentType?: string;
  options?: string[];
  /** Stored when a create leaves the field out; set by the store, so a system field may have one. */
  default?: unknown;
}

/** `T` is the stored value's type and `R` whether the field is required (a phantom, for `Infer`). */
export class FieldBuilder<T = unknown, R extends boolean = false> {
  declare readonly _type: T;
  declare readonly _required: R;

  constructor(
    readonly meta: FieldMeta,
    readonly schema: Schema
  ) {}

  /** The value must be present on create (an update may leave it out). */
  required(): FieldBuilder<T, true> {
    return new FieldBuilder<T, true>({ ...this.meta, required: true }, this.schema);
  }

  /** Writable only by a caller whose rule lists the field by name. */
  system(): FieldBuilder<T, R> {
    return new FieldBuilder<T, R>({ ...this.meta, system: true }, this.schema);
  }

  /**
   * The value a create stores when the field is left out. The store applies it whoever creates, so a system field
   * the creator may not write (a flag a rule reads, such as `retired: 0`) still starts with a value.
   */
  default(value: T): FieldBuilder<T, R> {
    return new FieldBuilder<T, R>({ ...this.meta, default: value }, this.schema);
  }

  /** Maximum length (text), value (number) or count (list). */
  max(value: number): FieldBuilder<T, R> {
    const key = this.schema.type === 'string' ? 'maxLength' : this.schema.type === 'number' ? 'maximum' : 'maxItems';
    return new FieldBuilder<T, R>(this.meta, { ...this.schema, [key]: value });
  }

  /** Minimum length (text), value (number) or count (list). */
  min(value: number): FieldBuilder<T, R> {
    const key = this.schema.type === 'string' ? 'minLength' : this.schema.type === 'number' ? 'minimum' : 'minItems';
    return new FieldBuilder<T, R>(this.meta, { ...this.schema, [key]: value });
  }
}

const make = <T>(label: string, fieldType: FieldType, schema: Schema, extra: Partial<FieldMeta> = {}) =>
  new FieldBuilder<T, false>({ label, fieldType, required: false, system: false, ...extra }, schema);

export interface StoredFile {
  name: string;
  size: number;
  url: string;
}

export const field = {
  text: (label: string) => make<string>(label, 'text', { type: 'string' }),
  longText: (label: string) => make<string>(label, 'longText', { type: 'string' }),
  /** Markdown, stored as a string. */
  markdown: (label: string) => make<string>(label, 'markdown', { type: 'string' }),
  url: (label: string) => make<string>(label, 'url', { type: 'string', format: 'uri' }),
  email: (label: string) => make<string>(label, 'email', { type: 'string', format: 'email' }),
  boolean: (label: string) => make<boolean>(label, 'boolean', { type: 'boolean' }),
  number: (label: string) => make<number>(label, 'number', { type: 'number' }),
  /** An ISO 8601 date and time. */
  date: (label: string) => make<string>(label, 'date', { type: 'string', format: 'date-time' }),
  select: <const O extends readonly string[]>(label: string, opts: { options: O }) =>
    make<O[number]>(label, 'select', { type: 'string', enum: [...opts.options] }, { options: [...opts.options] }),
  /** The id of an entry of another type. */
  ref: (contentType: string, label: string) =>
    make<string>(label, 'reference', { type: 'string' }, { refContentType: contentType }),
  /** Ids of entries of another type, in order. */
  refs: (contentType: string, label: string) =>
    make<string[]>(label, 'references', { type: 'array', items: { type: 'string' } }, { refContentType: contentType }),
  /** A read-only list of stored files, `{ name, size, url }` each. */
  files: (label: string) =>
    make<StoredFile[]>(label, 'files', {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, size: { type: 'number' }, url: { type: 'string' } },
        required: ['name', 'size', 'url']
      }
    }),
  /** Any JSON value. */
  json: <T = unknown>(label: string) => make<T>(label, 'json', {})
};
