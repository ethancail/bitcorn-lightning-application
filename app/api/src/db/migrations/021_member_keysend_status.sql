-- Track member nodes with keysend disabled (detected via rebalance failure)
CREATE TABLE IF NOT EXISTS member_keysend_status (
  peer_pubkey TEXT PRIMARY KEY,
  keysend_disabled INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_checked_at INTEGER,
  failure_message TEXT
);
