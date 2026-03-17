-- Member liquidity advisor: channel classification history + advisor config.
-- Runs on member nodes only. Reads local LND state, classifies treasury channel.

CREATE TABLE IF NOT EXISTS member_channel_classifications (
  classification_id              TEXT PRIMARY KEY,
  channel_id                     TEXT NOT NULL,
  capacity_sat                   INTEGER NOT NULL,
  member_local_sat               INTEGER NOT NULL,
  treasury_local_sat             INTEGER NOT NULL,
  member_local_pct               REAL NOT NULL,
  state                          TEXT NOT NULL,
  urgency                        TEXT NOT NULL,
  consecutive_non_healthy_runs   INTEGER NOT NULL DEFAULT 0,
  classified_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_member_classifications_channel
  ON member_channel_classifications(channel_id, classified_at DESC);

CREATE TABLE IF NOT EXISTS member_liquidity_advisor_config (
  id                              INTEGER PRIMARY KEY DEFAULT 1,
  target_mid_pct                  REAL NOT NULL DEFAULT 0.50,
  send_heavy_threshold_pct        REAL NOT NULL DEFAULT 0.70,
  send_saturated_threshold_pct    REAL NOT NULL DEFAULT 0.85,
  receive_heavy_threshold_pct     REAL NOT NULL DEFAULT 0.30,
  receive_exhausted_threshold_pct REAL NOT NULL DEFAULT 0.15,
  min_loop_sats                   INTEGER NOT NULL DEFAULT 50000,
  max_loop_sats                   INTEGER NOT NULL DEFAULT 2000000,
  floor_sats                      INTEGER NOT NULL DEFAULT 10000,
  check_interval_seconds          INTEGER NOT NULL DEFAULT 900,
  updated_at                      INTEGER NOT NULL DEFAULT 0
);

-- Seed default config row if not present
INSERT OR IGNORE INTO member_liquidity_advisor_config (id, updated_at)
  VALUES (1, 0);
