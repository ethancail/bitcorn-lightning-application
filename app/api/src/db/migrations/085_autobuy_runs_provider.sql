-- 085_autobuy_runs_provider.sql — the exchange each run bought on
-- (kraken-autobuy Slice 1 spec §3 P2, decision D4). The API derives each run's
-- hold end from it (ruling S2).
--
-- ONE STATEMENT PER FILE (see 084). Existing runs read 'coinbase' through the
-- default; from P4 on every insert writes the provider explicitly.
ALTER TABLE autobuy_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'coinbase' CHECK (provider IN ('coinbase', 'kraken'));
