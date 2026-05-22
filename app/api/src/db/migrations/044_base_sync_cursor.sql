-- Migration 044: base_sync_cursor — high-water mark for the §7 sync loop
--
-- Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7
--
-- Singleton (id=1). Records the most recent BASE block number the sync
-- loop successfully processed. Used to:
--   (a) Detect stale sync state when the UI renders cached balances
--       (compare cursor age to current time).
--   (b) Drive the eth_getLogs cursor in a future v1.1 (when /base/events
--       lands on the Worker; v1 of the sync loop does not yet read logs).
--
-- The cursor advances atomically with the balance/state writes per tick
-- (see app/api/src/base/sync.ts). Crash recovery resumes from the
-- last-committed cursor.

CREATE TABLE IF NOT EXISTS base_sync_cursor (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    last_synced_block_number    INTEGER NOT NULL,
    last_synced_at              INTEGER NOT NULL
);

-- Seed an initial row so UPSERT semantics from the sync loop find a target
-- to update. Pre-deployment block = 0; first successful tick replaces it.
INSERT OR IGNORE INTO base_sync_cursor (id, last_synced_block_number, last_synced_at)
    VALUES (1, 0, 0);
