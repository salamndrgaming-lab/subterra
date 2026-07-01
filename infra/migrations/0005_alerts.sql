-- Phase 6 — AOI change alerts.
--
-- Each alert is scoped to a saved AOI and an event kind (new claim filed,
-- permit filed, etc.), optionally narrowed by a filters JSON blob (state /
-- operator). The weekly scheduled worker diffs the latest ETL run against
-- each enabled alert's AOI and emails a digest of newly-added features.
--
-- last_notified_version tracks the diff `toVersion` we last emailed for, so
-- a given ETL run's changes are never emailed twice even if the cron runs
-- more than once.

CREATE TABLE IF NOT EXISTS alerts (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  event_kind            TEXT NOT NULL,
  aoi_id                TEXT REFERENCES aois(id) ON DELETE CASCADE,
  filters_json          TEXT NOT NULL DEFAULT '{}',
  is_enabled            INTEGER NOT NULL DEFAULT 1,
  last_notified_version INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(is_enabled);
