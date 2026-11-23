-- 086_autobuy_sweeps_provider.sql — the exchange each sweep withdrew from
-- (kraken-autobuy Slice 1 spec §3 P2, ruling S1: the drain guard reads it).
--
-- ONE STATEMENT PER FILE (see 084). Existing sweeps read 'coinbase' through the
-- default; from P4 on every insert writes the provider explicitly.
ALTER TABLE autobuy_sweeps ADD COLUMN provider TEXT NOT NULL DEFAULT 'coinbase' CHECK (provider IN ('coinbase', 'kraken'));
