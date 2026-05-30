-- Phase 9 — stake-ability eligibility cache.
--
-- The /eligibility endpoint answers "can a mining claim be located at
-- this point today?". Computing the answer requires point-in-polygon
-- queries against the withdrawals + critical_habitat + indian_lands +
-- parcels feature tables in subterra-features.db. To keep the drawer
-- snappy we cache the result per ~25 m S2 cell, keyed by the current
-- tile manifest's data_version so cache rows auto-invalidate after
-- each weekly ETL refresh.

CREATE TABLE IF NOT EXISTS eligibility_cache (
  cell_hash    TEXT PRIMARY KEY,         -- s2 cell at level 18 (~25 m)
  surface_mgmt TEXT,                     -- 'BLM' | 'USFS' | 'NPS' | 'Private' | 'Tribal' | ...
  mineral_mgmt TEXT,                     -- 'Federal' | 'Private' | 'Split' | 'Unknown'
  withdrawal   TEXT,                     -- NULL or withdrawal_type
  blockers     TEXT NOT NULL DEFAULT '[]',   -- JSON array of blocker codes
  stakeable    INTEGER NOT NULL,         -- 0/1
  computed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  data_version TEXT NOT NULL             -- matches /manifest.json version
);

CREATE INDEX IF NOT EXISTS idx_eligibility_version
  ON eligibility_cache(data_version);
