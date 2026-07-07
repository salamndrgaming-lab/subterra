-- Shareable prospect reports.
--
-- A user turns a drawn AOI's computed summary into a public read-only
-- report at /r/<token>. The payload is a snapshot (acres, commodity
-- breakdown, claims, cost estimate) captured client-side at share time —
-- the public viewer renders it without auth or map tiles. Deleting the
-- user cascades their shares.

CREATE TABLE IF NOT EXISTS shares (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
