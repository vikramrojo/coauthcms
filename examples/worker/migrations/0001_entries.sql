-- cogens: the content store's tables. Apply this first on a new database.
--
-- `entries` holds every content type's rows (the fields as JSON in `data`) and
-- `assets` the media rows. The first nine columns of `entries` are Koguma's own;
-- the last four are cogens's:
--   owner_id       who owns the row. The store compares it and gives it no other meaning.
--   parent_id      the entry this one belongs to (a type that names a `parent`).
--   sort_key       orders children under a parent.
--   parent_status  the parent's status, written by the store for types that mirror it
--                  (a generated column cannot read another row).
-- A host whose database already holds Koguma's `entries` (its 0001) applies
-- koguma-upgrade.sql instead of this file.
--
-- Indexed fields of your types are not here: they are columns generated from
-- the entry's JSON, and `cogens-print-migration <config>` prints their lines.

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  slug TEXT,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  publish_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  owner_id TEXT,
  parent_id TEXT,
  sort_key TEXT,
  parent_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(content_type);
CREATE INDEX IF NOT EXISTS idx_entries_slug ON entries(content_type, slug);
CREATE INDEX IF NOT EXISTS idx_entries_owner ON entries(owner_id, content_type);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(content_type, parent_id, sort_key);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id);
