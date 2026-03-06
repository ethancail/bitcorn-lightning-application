CREATE TABLE IF NOT EXISTS network_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_hash TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('send', 'receive')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
  amount_sats INTEGER NOT NULL,
  fee_sats INTEGER NOT NULL DEFAULT 0,
  exchange_rate_usd REAL,
  amount_usd REAL,
  memo TEXT,
  counterparty_pubkey TEXT,
  payment_request TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_network_payments_hash ON network_payments(payment_hash);
CREATE INDEX IF NOT EXISTS idx_network_payments_direction ON network_payments(direction);
CREATE INDEX IF NOT EXISTS idx_network_payments_status ON network_payments(status);
CREATE INDEX IF NOT EXISTS idx_network_payments_created ON network_payments(created_at);
