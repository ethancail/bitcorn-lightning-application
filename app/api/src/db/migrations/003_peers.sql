CREATE TABLE IF NOT EXISTS lnd_peers (
  pubkey TEXT PRIMARY KEY,
  address TEXT,
  bytes_sent INTEGER,
  bytes_received INTEGER,
  updated_at INTEGER NOT NULL
);
