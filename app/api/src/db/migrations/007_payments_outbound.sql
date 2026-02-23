CREATE TABLE IF NOT EXISTS payments_outbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_hash TEXT NOT NULL,
  payment_request TEXT NOT NULL,
  destination TEXT,
  tokens INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_outbound_hash
  ON payments_outbound(payment_hash);

CREATE INDEX IF NOT EXISTS idx_payments_outbound_status
  ON payments_outbound(status);

CREATE INDEX IF NOT EXISTS idx_payments_outbound_created
  ON payments_outbound(created_at);
