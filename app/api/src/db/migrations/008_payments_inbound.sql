CREATE TABLE IF NOT EXISTS payments_inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_hash TEXT NOT NULL UNIQUE,
  tokens INTEGER NOT NULL,
  settled_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_hash ON payments_inbound(payment_hash);
CREATE INDEX IF NOT EXISTS idx_inbound_settled ON payments_inbound(settled_at);
