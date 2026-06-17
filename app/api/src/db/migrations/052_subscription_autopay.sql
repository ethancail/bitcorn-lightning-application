-- Migration 052: Subscription auto-pay (member-node-local renewal).
--
-- Implements specs/2026-06-12-subscription-auto-pay-implementation.md §2.
-- Auto-pay is an opt-in, member-node-local mechanism: when the member's own
-- subscription tier is observed in a recoverable-lapsed state and auto-pay is
-- enabled, the member's node sends one cycle at the current server-derived
-- price from its own LND wallet via the existing pay-from-node path.
--
-- Two schema effects, one migration:
--   (a) Extend member_profile (migration 051) with the opt-in + price-
--       acknowledgment state. The profile row is already loaded on the Profile
--       read path (SELECT * in profileStore.getMemberProfile), so the opt-in
--       rides the same read with no new query and lives next to the alias it
--       sits below in the UI. Four small, member-keyed, 1:1 columns.
--   (b) A new subscription_autopay_alerts stored-alert table mirroring
--       autobuy_alerts (migration 050) — same lifecycle/dedup reasoning —
--       but member_pubkey-scoped and with a DELIBERATELY DIFFERENT severity
--       domain: ('info','warning'), not ('warning','critical'). Auto-pay has
--       no 'critical' (a failed renewal is action-required but not catastrophic
--       given the long grace runway) and DOES have 'info' (AUTOPAY_SUCCEEDED).
--       Do not "align" this to the autobuy CHECK.
--
-- Idempotency: the runner (db/migrate.ts) swallows "duplicate column" /
-- "already exists" errors and otherwise crashes boot, so each statement is
-- written to be independently safe on a re-run.
--
-- No backfill. The table starts empty; opt-in defaults to 0 (off). At opt-in,
-- the endpoint seeds last_acknowledged_price to the current price so the
-- price-change banner starts in the matched (silent) state.

-- (a) Opt-in + price-acknowledgment state on the existing member_profile row.
ALTER TABLE member_profile ADD COLUMN auto_pay_enabled            INTEGER NOT NULL DEFAULT 0;  -- boolean 0/1
ALTER TABLE member_profile ADD COLUMN auto_pay_enabled_at         INTEGER;                     -- epoch seconds, nullable
ALTER TABLE member_profile ADD COLUMN last_acknowledged_price     INTEGER;                     -- sats, nullable
ALTER TABLE member_profile ADD COLUMN last_acknowledged_price_at  INTEGER;                     -- epoch seconds, nullable

-- (b) Stored-alert table, same shape as autobuy_alerts (050), keyed on member_pubkey.
CREATE TABLE IF NOT EXISTS subscription_autopay_alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_pubkey     TEXT    NOT NULL,                 -- the member this alert belongs to
  type              TEXT    NOT NULL,                 -- canonical AUTOPAY_* type (spec §5)
  severity          TEXT    NOT NULL CHECK (severity IN ('info','warning')),
  status            TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','resolved','dismissed')),
  consecutive_count INTEGER NOT NULL DEFAULT 1,       -- recurrences while active (also the retry-backoff signal, §5)
  context_json      TEXT,                             -- JSON blob, scenario-specific (§5)
  created_at        INTEGER NOT NULL,                 -- epoch seconds, first occurrence
  updated_at        INTEGER NOT NULL,                 -- epoch seconds, last occurrence or state change
  resolved_at       INTEGER,                          -- set when auto-cleared (status -> 'resolved')
  dismissed_at      INTEGER                           -- set when user dismisses (status -> 'dismissed')
);

CREATE INDEX IF NOT EXISTS idx_autopay_alerts_member_type_status
  ON subscription_autopay_alerts(member_pubkey, type, status);
CREATE INDEX IF NOT EXISTS idx_autopay_alerts_created
  ON subscription_autopay_alerts(created_at);
