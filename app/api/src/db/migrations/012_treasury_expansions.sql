CREATE TABLE IF NOT EXISTS treasury_expansion_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_pubkey TEXT NOT NULL,
  channel_id TEXT,
  classification TEXT NOT NULL,
  velocity_24h_sats INTEGER NOT NULL,
  imbalance_ratio REAL NOT NULL,
  suggested_capacity_sats INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expansion_rec_peer ON treasury_expansion_recommendations(peer_pubkey);
CREATE INDEX IF NOT EXISTS idx_expansion_rec_created ON treasury_expansion_recommendations(created_at);

CREATE TABLE IF NOT EXISTS treasury_expansion_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_pubkey TEXT NOT NULL,
  requested_capacity_sats INTEGER NOT NULL,
  status TEXT NOT NULL,
  funding_txid TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expansion_exec_peer ON treasury_expansion_executions(peer_pubkey);
CREATE INDEX IF NOT EXISTS idx_expansion_exec_status ON treasury_expansion_executions(status);
CREATE INDEX IF NOT EXISTS idx_expansion_exec_created ON treasury_expansion_executions(created_at);
