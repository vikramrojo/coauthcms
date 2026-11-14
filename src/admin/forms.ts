/**
 * A posted form into what the store takes. Every key in the body is passed on,
 * whether or not the page drew an input for it, so a forged field reaches the
 * store's own rules and is refused there; nothing here decides what may be written.
 */
import type { ContentType, FieldMeta } from '../core/index.ts';

export interface Parsed {
  values: Record<string, unknown>;
  /** Fields whose text could not be read (JSON that is not JSON). */
  errors: { field: string; message: string }[];
}

function coerce(meta: FieldMeta, raw: string): unknown {
  switch (meta.fieldType) {
    case 'number': {
      if (raw.trim() === '') return null;
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : null;
    case 'references':
      return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    case 'markdown':
    case 'longText':
      // A text area submits line ends as CRLF; the stored text keeps LF.
      return raw === '' ? null : raw.replace(/\r\n/g, '\n');
    default:
      return raw === '' ? null : raw;
  }
}

export function parseForm(type: Pick<ContentType<any>, 'fieldMeta'>, form: FormData): Parsed {
  const values: Record<string, unknown> = {};
  const errors: Parsed['errors'] = [];
  const keys = new Set<string>();
  form.forEach((_, key) => keys.add(key));
  for (const key of keys) {
    const raw = form.getAll(key).filter((v): v is string => typeof v === 'string');
    const last = raw[raw.length - 1] ?? '';
    const meta = type.fieldMeta[key];
    if (!meta) {
      values[key] = last === '' ? null : last;
      continue;
    }
    if (meta.fieldType === 'json') {
      if (last.trim() === '') values[key] = null;
      else {
        try {
          values[key] = JSON.parse(last);
        } catch {
          errors.push({ field: key, message: 'is not valid JSON.' });
        }
      }
      continue;
    }
    values[key] = coerce(meta, last);
  }
  return { values, errors };
}

/** A form's text for a built-in column: empty means none. */
export const columnValue = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
