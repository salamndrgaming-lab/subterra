-- Phase 4 — user-tracked BLM mining claims.
--
-- The single subscription-justifying feature on the catalog: surface a
-- countdown to the next BLM annual maintenance-fee deadline (Sept 1)
-- for every claim the user has marked as theirs. Miss Sept 1 → lose
-- the claim. Every active staker tracks this in a spreadsheet today.
--
-- Minimal schema: claim serial + user-provided name/notes. Per-claim
-- maintenance dates aren't stored because they're identical for every
-- claim (Sept 1 every year). Claim detail (claimant, acreage, location
-- date, etc.) can be backfilled from features.db later — for the MVP,
-- the user types in whatever metadata they want to remember.

CREATE TABLE IF NOT EXISTS tracked_claims (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  serial          TEXT NOT NULL,                 -- BLM serial (e.g. "NMC1234567")
  name            TEXT,                          -- user nickname
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Same user shouldn't accidentally double-add the same serial.
  UNIQUE(user_id, serial)
);
CREATE INDEX IF NOT EXISTS idx_tracked_claims_user ON tracked_claims(user_id);
