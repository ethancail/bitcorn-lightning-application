CREATE TABLE IF NOT EXISTS treasury_rebalance_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  fee_paid_sats INTEGER NOT NULL,
  related_channel TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rebalance_created
  ON treasury_rebalance_costs(created_at);
