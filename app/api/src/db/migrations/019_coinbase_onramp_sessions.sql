CREATE TABLE IF NOT EXISTS coinbase_onramp_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_pubkey TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
