-- Migration 054: claim linkage for passed-over Auto-Buy intervals.
--
-- Implements bitcorn-research/specs/2026-09-14-autobuy-scheduler-catchup-clamp-spec.md
-- §4 A6, under decisions/2026-09-14-autobuy-scheduler-catchup-clamp.md (D1).
--
-- WHY A COLUMN AND NOT A STATUS FLIP. A passed-over interval has TWO facts
-- about it: that it was missed, and whether it has since been bought. Flipping
-- autobuy_runs.status from 'skipped_missed_interval' to something like
-- 'missed_interval_claimed' would overload one column with both, and would
-- make the history table stop saying the interval was ever missed. The status
-- stays truthful and the claim is a separate, nullable fact.
--
-- NULL means unclaimed. Set to the id of the catch-up 'buy_placed' run that
-- bought this interval. "Unclaimed" is therefore:
--   status = 'skipped_missed_interval' AND claimed_by_run_id IS NULL
--
-- Deliberately NOT a REAL foreign key: SQLite cannot add an FK constraint via
-- ALTER TABLE ADD COLUMN without a table rebuild, and the referent is a row in
-- this same table that is never deleted. The linkage is enforced in code at the
-- single write site (autoBuy/scheduler.ts, runCatchUp).
--
-- Idempotency: the runner (db/migrate.ts) swallows "duplicate column" and
-- "already exists" errors and crashes boot on anything else, so a re-run of
-- this ADD COLUMN is safe.

ALTER TABLE autobuy_runs ADD COLUMN claimed_by_run_id INTEGER;

-- Reads are always "unclaimed rows of one status", so the index pairs them.
CREATE INDEX IF NOT EXISTS idx_autobuy_runs_status_claim
  ON autobuy_runs(status, claimed_by_run_id);
