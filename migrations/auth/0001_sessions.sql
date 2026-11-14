-- cogens/auth: the tables of sessions, handoff tokens, identities and the
-- password sign-in. Needed only by a host that imports `cogens/auth`;
-- independent of 0001_entries.sql.

-- Sessions: a row behind each signed cookie. kind is who the session is for
-- ('admin', or the host's own); method is how it was made ('password', 'handoff',
-- later a provider); owner_id is null for the operator. created_at and
-- expires_at are milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One-time handoff tokens: only the SHA-256 of the token is kept, and an exchange
-- deletes the row (DELETE ... RETURNING), so a token is used once. expires_at is
-- milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS handoff_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_expires ON handoff_tokens(expires_at);

-- Who an owner is at a sign-in provider; empty until a provider is added.
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_owner ON identities(owner_id);

-- The password sign-in's rate limit and its meta values.
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts ON auth_attempts(ip, attempted_at);

CREATE TABLE IF NOT EXISTS auth_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
