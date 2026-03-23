-- Migration 031: Approved external peers for swap egress routing.
-- Treasury operator maintains this list to control which external channels
-- are eligible for member Loop Out egress. Starts with ACINQ.

CREATE TABLE IF NOT EXISTS swap_egress_peers (
  pubkey       TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Seed ACINQ as the default approved egress peer
INSERT OR IGNORE INTO swap_egress_peers (pubkey, label, enabled, notes, created_at, updated_at)
VALUES (
  '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  'ACINQ',
  1,
  'Default Loop Out egress peer — verified mainnet 2026-03-11',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
