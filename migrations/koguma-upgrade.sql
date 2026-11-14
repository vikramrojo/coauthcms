-- coauthcms: for a database that already holds Koguma's `entries` and `assets`
-- (Koguma's 0001) and not 0001_entries.sql. Adds the ownership columns and
-- indexes. Run it once: ADD COLUMN fails on a column that is there, which is how
-- you learn it was already applied.

ALTER TABLE entries ADD COLUMN owner_id TEXT;
ALTER TABLE entries ADD COLUMN parent_id TEXT;
ALTER TABLE entries ADD COLUMN sort_key TEXT;
ALTER TABLE entries ADD COLUMN parent_status TEXT;
ALTER TABLE assets ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_entries_owner ON entries(owner_id, content_type);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(content_type, parent_id, sort_key);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id);
