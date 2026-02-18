CREATE TABLE IF NOT EXISTS treasury_channel_fee_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  peer_pubkey TEXT NOT NULL,
  health_classification TEXT NOT NULL,
  imbalance_ratio REAL NOT NULL,
  base_fee_rate_ppm INTEGER NOT NULL,
  target_fee_rate_ppm INTEGER NOT NULL,
  adjustment_factor REAL NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_fee_log_channel
  ON treasury_channel_fee_log(channel_id);

CREATE INDEX IF NOT EXISTS idx_channel_fee_log_applied
  ON treasury_channel_fee_log(applied_at);
