-- Migration 049: Currency-adaptive Auto-Buy (Phase 1)
--
-- Implements specs/2026-06-03-currency-adaptive-autobuy-phase-1.md §1.
-- The Auto-Buy can now spend USD or USDC, governed by a per-node user
-- preference, instead of unconditionally placing BTC-USD orders.
--
-- Numbering note: this release is cut directly off `main` (HEAD = migration
-- 042), but `develop` has already reserved 043–048 for the unreleased
-- stablecoin-rail (BASE) work. Allocating 049 keeps this migration above
-- that reserved block so the two lines never collide when BASE later merges
-- to main. The migration runner discovers files by name and sorts
-- lexicographically (db/migrate.ts), so the temporary 042→049 gap on main is
-- harmless — it never reasons about contiguity.
--
-- Three schema effects:
--   (a) autobuy_config.currency_preference — new per-node setting, defaulting
--       to 'usdc_preferred' (Option C, USDC-first) per the decision record.
--       The column default applies to the existing singleton row, so a node
--       whose config predates this feature reads back 'usdc_preferred'.
--   (b) Rename the shortfall state value skipped_insufficient_usd →
--       skipped_insufficient_funds (the value lives in autobuy_runs.status),
--       backfilling existing rows. The old string is retired from new code.
--   (c) autobuy_runs.currencies_checked / currency_used — observability for
--       which currencies a run considered and which one it spent. NULL for
--       pre-existing rows; the history API + UI tolerate NULL.
--
-- Idempotency: the runner only swallows "duplicate column"/"already exists"
-- errors and otherwise crashes boot, so each statement is written to be
-- independently safe on a re-run — the ADD COLUMNs are guarded by that catch,
-- and the UPDATE is naturally idempotent (no rows match after the first run).

-- (a) Per-node currency preference. CHECK enforces the four canonical values
--     (defense in depth alongside the server-side PATCH validation).
ALTER TABLE autobuy_config
  ADD COLUMN currency_preference TEXT NOT NULL DEFAULT 'usdc_preferred'
  CHECK (currency_preference IN ('usd_only','usdc_only','usd_preferred','usdc_preferred'));

-- (b) Backfill the renamed shortfall state. After this, no new code emits the
--     old value (see scheduler.ts) and no legacy rows retain it.
UPDATE autobuy_runs
   SET status = 'skipped_insufficient_funds'
 WHERE status = 'skipped_insufficient_usd';

-- (c) Per-run currency observability. Nullable; NULL on all pre-existing rows.
ALTER TABLE autobuy_runs ADD COLUMN currencies_checked TEXT;
ALTER TABLE autobuy_runs ADD COLUMN currency_used TEXT;
