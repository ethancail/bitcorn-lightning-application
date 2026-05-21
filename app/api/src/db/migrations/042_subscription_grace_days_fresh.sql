-- Migration 042: Pre-payment "fresh" grace window for new subscribers
--
-- Adds grace_days_fresh to subscription_policy. Members who have signed
-- up (subscription row exists) but never paid (no subscription_payment
-- rows) are computed as `current` instead of `prepay` for grace_days_fresh
-- days from their created_at. After that window expires with no payment
-- they fall through to `prepay` as before.
--
-- Default 30 days matches one full subscription period — a fresh member
-- has one complete cycle to evaluate Auto-Buy and the rest of the
-- full-scope feature set before their JWT scope drops to payment-only.
--
-- The dispatch (tierDispatch.ts) consumes this on the next sync-loop
-- tick after migration runs. The member-side transition observer then
-- detects the resulting scope upgrade and triggers an out-of-band token
-- refresh, so already-installed members on prepay flip to full-scope
-- within one status-poll cycle (~15s) without an API restart.

ALTER TABLE subscription_policy
  ADD COLUMN grace_days_fresh INTEGER NOT NULL DEFAULT 30;

-- Bump updated_at so any operator-facing change-tracking surfaces the
-- new policy field even though the runtime value matches the default.
UPDATE subscription_policy
   SET updated_at = (strftime('%s','now') * 1000)
 WHERE id = 1;
