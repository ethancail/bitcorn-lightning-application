-- 073: the pay-from-node settlement guard's marker (pay-from-node D2).
-- Numbered 073, not 071: membership-gating takes 071 and 072 (ruled
-- 2026-11-05). The runner applies every unapplied file in filename order, so
-- a node that receives this before 071/072 still applies all three.
--
-- Source of truth:
--   bitcorn-research/decisions/2026-11-05-pay-from-node-confirmation-by-echo-
--     settlement-guard-and-price-ceiling.md (D2)
--   bitcorn-research/decisions/2026-11-05-pay-from-node-d2-supersedes-v1-no-
--     dedupe-ledger-judgment.md
--   bitcorn-research/specs/2026-11-05-pay-from-node-spec.md §3.1
--
-- Both payment paths (the manual route and the auto-pay scheduler) write one
-- row here, committed, BEFORE broadcasting the subscription payment. While a
-- row is active (cleared_at IS NULL) auto-pay refuses to send, and a manual
-- send needs the member's deliberate acknowledgement. A row clears only when
-- the treasury's status shows the payment credited.
--
-- Member-local. Runs on every node, treasury included, where it stays empty.
-- ADDITIVE ONLY, and every statement is idempotent on its own: the migration
-- runner records a file as applied when db.exec throws "already exists", so a
-- statement that could fail partway would leave the ones after it unrun.

CREATE TABLE IF NOT EXISTS subscription_send_marker (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_pubkey               TEXT    NOT NULL,                 -- this node's pubkey (member_profile's key)
  origin                      TEXT    NOT NULL CHECK (origin IN ('manual','auto')),
  amount_sats                 INTEGER NOT NULL,                 -- the server-derived amount about to be sent
  deposit_address             TEXT    NOT NULL,                 -- the server-derived destination
  paid_through_at_write       INTEGER,                          -- status paid_through (ms) when written
  last_payment_txid_at_write  TEXT,                             -- status last_payment_txid when written
  created_at                  INTEGER NOT NULL,                 -- epoch seconds
  txid                        TEXT,                             -- NULL until the broadcast returns one
  cleared_at                  INTEGER,                          -- epoch seconds; NULL while active
  cleared_reason              TEXT                              -- 'credited_txid' | 'credited_paid_through'
);

CREATE INDEX IF NOT EXISTS idx_send_marker_member_active
  ON subscription_send_marker(member_pubkey, cleared_at);
