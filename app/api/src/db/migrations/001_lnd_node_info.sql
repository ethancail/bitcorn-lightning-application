CREATE TABLE IF NOT EXISTS lnd_node_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pubkey TEXT NOT NULL,
  alias TEXT,
  network TEXT NOT NULL,
  block_height INTEGER,
  synced_to_chain INTEGER,
  block_drift INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lnd_node_info_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pubkey TEXT NOT NULL,
  alias TEXT,
  network TEXT NOT NULL,
  block_height INTEGER,
  synced_to_chain INTEGER,
  block_drift INTEGER,
  recorded_at INTEGER NOT NULL
);
