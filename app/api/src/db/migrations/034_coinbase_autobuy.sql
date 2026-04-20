-- 034_coinbase_autobuy.sql — Coinbase Auto-Buy Executor tables.
--
-- Four tables: credentials (singleton encrypted Cloud Key), config (singleton
-- per-node settings + runtime state), runs (one row per scheduled buy, moves
-- through the state machine), sweeps (one row per weekly withdraw batch).
--
-- Numbered 034 because 028–033 are taken by unrelated migrations that landed
-- while this feature was on a branch (advisor_min_channel_capacity through
-- valuation_manual_inputs).

CREATE TABLE IF NOT EXISTS coinbase_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_name TEXT NOT NULL,
  encrypted_private_key BLOB NOT NULL,
  nonce BLOB NOT NULL,
  connected_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS autobuy_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  base_unit_usd REAL NOT NULL DEFAULT 100,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  zone_multipliers TEXT NOT NULL DEFAULT '{"extreme_buy":3,"undervalued":2,"fair_value":1,"elevated":0.5,"overvalued":0.25,"extreme_sell":0}',
  withdraw_address TEXT NOT NULL DEFAULT '',
  withdraw_address_whitelisted_at INTEGER,
  sweep_day_of_week INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER
);

-- Seed the singleton config row with defaults. The withdraw_address stays
-- empty until the first GET /api/autobuy/status call generates one via
-- createLndChainAddress() (done in business logic, not in this migration).
INSERT OR IGNORE INTO autobuy_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS autobuy_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_for INTEGER NOT NULL,
  z_score REAL,
  zone TEXT,
  multiplier REAL,
  base_unit_usd REAL,
  intended_buy_usd REAL,
  status TEXT NOT NULL,
  coinbase_order_id TEXT,
  filled_btc REAL,
  filled_usd REAL,
  filled_at INTEGER,
  withdraw_txid TEXT,
  withdraw_sweep_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autobuy_runs_status
  ON autobuy_runs(status);
CREATE INDEX IF NOT EXISTS idx_autobuy_runs_scheduled
  ON autobuy_runs(scheduled_for);

CREATE TABLE IF NOT EXISTS autobuy_sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swept_at INTEGER NOT NULL,
  btc_amount REAL NOT NULL,
  coinbase_tx_id TEXT,
  withdraw_txid TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_autobuy_sweeps_status
  ON autobuy_sweeps(status);
