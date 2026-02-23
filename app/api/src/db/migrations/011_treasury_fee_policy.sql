CREATE TABLE IF NOT EXISTS treasury_fee_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_fee_msat INTEGER NOT NULL,
  fee_rate_ppm INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_applied_at INTEGER
);

INSERT OR IGNORE INTO treasury_fee_policy (id, base_fee_msat, fee_rate_ppm, updated_at, last_applied_at)
VALUES (1, 0, 0, (strftime('%s','now') * 1000), NULL);
