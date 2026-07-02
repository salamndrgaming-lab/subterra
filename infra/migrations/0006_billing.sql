-- Phase 7 — Stripe billing.
--
-- users already has `tier` + `stripe_customer_id` (baseline). Add the
-- subscription bookkeeping the webhook updates so the app can show sub
-- status and the correct upgrade/manage affordance.

ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT;         -- active | past_due | canceled | ...
ALTER TABLE users ADD COLUMN subscription_period_end TEXT;     -- ISO; end of current paid period
