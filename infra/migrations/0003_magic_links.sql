-- Phase 4 — email magic-link authentication tokens.
--
-- The original Phase 4 design used WebAuthn passkeys (see the passkeys
-- table in 0001_baseline.sql). Magic links ship first because they
-- need ~zero client-side complexity, work on every device including
-- desert-prospector field phones with no biometric hardware, and
-- reuse the Resend integration that Phase 6 alerts already need.
--
-- Tokens are stored as SHA-256 hashes — the raw token lives only in
-- the email link. Single-use (consumed_at) + short TTL (15 minutes).

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash    TEXT PRIMARY KEY,            -- hex SHA-256 of the raw URL token
  email         TEXT NOT NULL,               -- lower-cased; matches users.email on consume
  expires_at    TEXT NOT NULL,               -- ISO-8601 UTC, 15 min after issue
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at   TEXT                          -- set when /auth/verify accepts it
);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
