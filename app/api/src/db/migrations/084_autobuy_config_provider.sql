-- 084_autobuy_config_provider.sql — which exchange the node's Auto-Buy uses
-- (kraken-autobuy Slice 1 spec §3 P2, decision D4, ruling S1).
--
-- ONE STATEMENT PER FILE: db/migrate.ts marks a whole file applied when it hits
-- "duplicate column", so a second statement here could be skipped for good.
--
-- NOT NULL DEFAULT 'coinbase' is what makes every existing row read 'coinbase'
-- (SQLite fills an added column's default into existing rows). New writes set
-- the provider explicitly from P4 on; the default exists for old rows.
ALTER TABLE autobuy_config ADD COLUMN provider TEXT NOT NULL DEFAULT 'coinbase' CHECK (provider IN ('coinbase', 'kraken'));
