-- Migration 036: Member subscription (on-chain, 50,000 sats/month)
-- Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §2/§4.1
--
-- Stage 1 of the spec's rollout: schema + policy only. Detection, enforcement,
-- entitlement tokens, and UI ship in later migrations / PRs. No business logic
-- references these tables yet.
--
-- All four tables ship together per §4.1: pending-attribution is "small enough
-- to ship inside the same migration as the three core tables".

-- Single-row policy table. Mirrors the existing treasury_fee_policy /
-- treasury_capital_policy idiom: id CHECK (id = 1), updated_at bumped on
-- every change. No separate audit table in v1; the audit-table retrofit
-- across all three single-row policies is queued as one future cleanup pass
-- (see decisions/2026-05-08-on-chain-monthly-subscription-rail.md).
CREATE TABLE IF NOT EXISTS subscription_policy (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  price_sats               INTEGER NOT NULL DEFAULT 50000,
  period_days              INTEGER NOT NULL DEFAULT 30,
  grace_days_worker        INTEGER NOT NULL DEFAULT 7,
  grace_days_routing       INTEGER NOT NULL DEFAULT 30,
  grace_days_close         INTEGER NOT NULL DEFAULT 60,
  underpay_tolerance_pct   INTEGER NOT NULL DEFAULT 95,
  updated_at               INTEGER NOT NULL
);

INSERT OR IGNORE INTO subscription_policy (
  id, price_sats, period_days,
  grace_days_worker, grace_days_routing, grace_days_close,
  underpay_tolerance_pct, updated_at
) VALUES (
  1, 50000, 30,
  7, 30, 60,
  95, (strftime('%s','now') * 1000)
);

-- One row per member. current_tier is computed by the sync loop on each
-- iteration and stored for fast read; see spec §5 for the state machine.
CREATE TABLE IF NOT EXISTS subscription (
  member_pubkey       TEXT PRIMARY KEY,
  deposit_address     TEXT NOT NULL UNIQUE,
  derivation_path     TEXT NOT NULL,
  paid_through        INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_payment_txid   TEXT,
  last_payment_at     INTEGER,
  current_tier        TEXT NOT NULL CHECK (current_tier IN (
    'prepay', 'current', 'worker_lapsed', 'routing_lapsed', 'close_due'
  ))
);

CREATE INDEX IF NOT EXISTS idx_subscription_deposit_address
  ON subscription(deposit_address);
CREATE INDEX IF NOT EXISTS idx_subscription_current_tier
  ON subscription(current_tier);

-- Append-only ledger. txid/vout NULL only when kind = 'admin_override'.
-- ON DELETE RESTRICT: payments are immutable history; members are not
-- deletable while any history exists.
CREATE TABLE IF NOT EXISTS subscription_payment (
  id                              INTEGER PRIMARY KEY,
  member_pubkey                   TEXT NOT NULL
    REFERENCES subscription(member_pubkey) ON DELETE RESTRICT,
  txid                            TEXT,
  vout                            INTEGER,
  amount_sats                     INTEGER NOT NULL,
  amount_usd_cents_at_receipt     INTEGER,
  received_at                     INTEGER NOT NULL,
  confirmed_at                    INTEGER,
  period_extension_days           INTEGER NOT NULL,
  kind                            TEXT NOT NULL CHECK (kind IN (
    'onchain', 'admin_override'
  )),
  admin_reason                    TEXT,
  CHECK (
    (kind = 'admin_override' AND admin_reason IS NOT NULL)
    OR (kind = 'onchain' AND txid IS NOT NULL AND vout IS NOT NULL)
  )
);

-- Prevent double-credits on duplicate sync-loop processing of the same
-- on-chain output. The partial WHERE clause skips admin_override rows
-- (txid IS NULL), so multiple manual extensions for one member don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payment_txid_vout
  ON subscription_payment(txid, vout)
  WHERE txid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_payment_member_confirmed
  ON subscription_payment(member_pubkey, confirmed_at DESC);

-- Audit bucket for on-chain receipts that landed at a known deposit address
-- but fell below the underpayment tolerance. Surfaced in the admin
-- "Subscriptions" view; resolved via admin override (which writes a
-- subscription_payment row with kind = 'admin_override') or ignored.
CREATE TABLE IF NOT EXISTS subscription_pending_attribution (
  id              INTEGER PRIMARY KEY,
  txid            TEXT NOT NULL,
  vout            INTEGER NOT NULL,
  amount_sats     INTEGER NOT NULL,
  member_pubkey   TEXT NOT NULL
    REFERENCES subscription(member_pubkey) ON DELETE RESTRICT,
  received_at     INTEGER NOT NULL,
  confirmed_at    INTEGER NOT NULL,
  reason          TEXT NOT NULL
);

-- Same dedupe defense as subscription_payment: prevents the sync loop
-- from re-recording the same below-tolerance output on subsequent passes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_pending_txid_vout
  ON subscription_pending_attribution(txid, vout);
