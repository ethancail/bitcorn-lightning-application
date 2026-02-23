CREATE TABLE IF NOT EXISTS lnd_channels (
  channel_id TEXT PRIMARY KEY,
  peer_pubkey TEXT NOT NULL,
  capacity_sat INTEGER NOT NULL,
  local_balance_sat INTEGER NOT NULL,
  remote_balance_sat INTEGER NOT NULL,
  active INTEGER NOT NULL,
  private INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lnd_channels_peer
  ON lnd_channels(peer_pubkey);
