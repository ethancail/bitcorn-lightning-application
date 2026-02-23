CREATE TABLE IF NOT EXISTS treasury_rotation_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  peer_pubkey TEXT NOT NULL,
  capacity_sats INTEGER NOT NULL,
  local_sats INTEGER NOT NULL,
  roi_ppm INTEGER NOT NULL,
  reason TEXT NOT NULL,
  is_force_close INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,  -- requested / submitted / failed
  closing_txid TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rotation_exec_created
  ON treasury_rotation_executions(created_at);

CREATE INDEX IF NOT EXISTS idx_rotation_exec_status
  ON treasury_rotation_executions(status);
