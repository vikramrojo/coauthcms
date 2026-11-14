/** Names of columns of `entries` that more than the SQL layer needs (the migration printer, the startup check). */

/** The column a generated (indexed) field is read from. */
export const indexedColumn = (field: string) => `f_${field}`;

/** The built-in columns a migration adds beyond Koguma's, which startup looks for. */
export const ADDED_COLUMNS = ['owner_id', 'parent_id', 'sort_key', 'parent_status'] as const;
