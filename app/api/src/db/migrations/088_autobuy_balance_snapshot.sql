-- 088_autobuy_balance_snapshot.sql — the last balance read per provider
-- (kraken-autobuy Slice 1 spec §3 P2, ruling S3). Written each tick while that
-- provider is enabled and served to polls, so a poll makes no exchange call (P5).
--
-- One row per provider, upserted; no history. Each *_available is buying power
-- (Kraken: balance + credit - credit_used - hold_trade), not a withdrawable
-- amount. NULL means the asset was absent from the exchange's response.
--
-- ONE STATEMENT PER FILE (see 084).
CREATE TABLE IF NOT EXISTS autobuy_balance_snapshot (
  provider TEXT NOT NULL PRIMARY KEY CHECK (provider IN ('coinbase', 'kraken')),
  usd_available REAL,
  usdc_available REAL,
  btc_available REAL,
  read_at INTEGER NOT NULL
);
