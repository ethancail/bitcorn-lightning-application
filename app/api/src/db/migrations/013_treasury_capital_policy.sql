CREATE TABLE IF NOT EXISTS treasury_capital_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  min_onchain_reserve_sats INTEGER NOT NULL,
  max_deploy_ratio_ppm INTEGER NOT NULL,
  max_pending_opens INTEGER NOT NULL,
  max_peer_capacity_sats INTEGER NOT NULL,
  peer_cooldown_minutes INTEGER NOT NULL,
  max_expansions_per_day INTEGER NOT NULL,
  max_daily_deploy_sats INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_applied_at INTEGER
);

INSERT OR IGNORE INTO treasury_capital_policy (
  id,
  min_onchain_reserve_sats,
  max_deploy_ratio_ppm,
  max_pending_opens,
  max_peer_capacity_sats,
  peer_cooldown_minutes,
  max_expansions_per_day,
  max_daily_deploy_sats,
  updated_at,
  last_applied_at
) VALUES (
  1,
  300000,
  600000,
  1,
  300000,
  720,
  3,
  400000,
  (strftime('%s','now') * 1000),
  NULL
);
