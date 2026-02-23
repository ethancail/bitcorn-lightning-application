CREATE TABLE IF NOT EXISTS treasury_rebalance_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  outgoing_channel TEXT NOT NULL,
  incoming_channel TEXT NOT NULL,
  max_fee_sats INTEGER NOT NULL,
  status TEXT NOT NULL,
  payment_hash TEXT,
  fee_paid_sats INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rebalance_exec_created ON treasury_rebalance_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_rebalance_exec_status ON treasury_rebalance_executions(status);
