-- Baseline migration — equivalent to infra/d1-schema.sql.
-- Wrangler applies migrations in lexical order; keeping the baseline
-- as 0001 means subsequent additive migrations (0002+) sit next to it.
-- See infra/d1-schema.sql for the authoritative comment block.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  tier          TEXT NOT NULL DEFAULT 'free'
                  CHECK (tier IN ('free','prospector','operator','enterprise')),
  stripe_customer_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS aois (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  notes         TEXT,
  geometry_json TEXT NOT NULL,
  bbox_west     REAL NOT NULL,
  bbox_south    REAL NOT NULL,
  bbox_east     REAL NOT NULL,
  bbox_north    REAL NOT NULL,
  area_acres    REAL NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aois_user ON aois(user_id);
-- NOTE: Cloudflare D1 does NOT compile the rtree SQLite extension, so a
-- `CREATE VIRTUAL TABLE ... USING rtree` here fails with SQLITE_AUTH
-- (code 7500). For zero-user pre-launch scale the bbox columns + the
-- per-user index above are sufficient for AOI overlap queries; revisit
-- with a manually-indexed approach (e.g. geohash prefix column) if/when
-- AOI count crosses ~10k per user.

CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  event_kind    TEXT NOT NULL,
  aoi_id        TEXT REFERENCES aois(id) ON DELETE SET NULL,
  filters_json  TEXT NOT NULL DEFAULT '{}',
  delivery_json TEXT NOT NULL DEFAULT '["email"]',
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(is_enabled) WHERE is_enabled = 1;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  tier                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
