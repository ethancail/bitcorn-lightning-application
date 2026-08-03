-- Migration 053: split "the sync tick ran" from "the sync tick succeeded"
--
-- THE BUG THIS FIXES. base_sync_cursor.last_synced_at (migration 044) was
-- touched whenever a tick got far enough to read ANY chain data — see the
-- pre-fix sync.ts step 6, which refreshed the timestamp on `chainTip != null`.
-- But the cursor's BLOCK number only advances when Settled events actually
-- commit. Those two can diverge: if /base/events errors while /base/balance
-- succeeds, event ingestion is dead, the block number freezes, and the
-- timestamp keeps ticking — so the UI's staleness banner reported "fresh"
-- while the member's settlement history had silently stopped updating.
--
-- A hard failure therefore looked HEALTHIER than a misconfiguration (which
-- leaves the seeded 0 and reads as maximally stale). Inverted signal.
--
-- The split:
--   last_attempt_at  — every tick that got past the early-return guards.
--                      Diagnostic only; nothing user-facing reads it. Answers
--                      "is the loop alive?"
--   last_success_at  — only when the Settled stream is provably current: this
--                      tick committed every chunk up to (tip − confirmation
--                      depth), or the cursor was already there with nothing to
--                      fetch. This is what drives the staleness banner.
--
-- last_synced_block_number keeps its meaning (last block whose Settled events
-- are committed) and is unchanged.
--
-- last_synced_at is KEPT and written in lockstep with last_success_at. It is
-- NOT NULL with no default, so it cannot be dropped without a table rebuild,
-- and app/api/scripts/base-rail-ops.ts plus any operator doing raw SQLite reads
-- still expect it. Treat it as a deprecated alias of last_success_at; new code
-- reads last_success_at.
--
-- BACKFILL: both new columns seed from last_synced_at rather than 0, so an
-- existing install that HAS been syncing does not suddenly report
-- never-synced and flash a banner on upgrade. A fresh install's 044 seed is
-- already 0, which is exactly the never_synced sentinel.
--
-- IDEMPOTENCY: bare ALTER TABLE ... ADD COLUMN is safe here, and this is the
-- established precedent (migration 042 does the same). SQLite has no
-- ADD COLUMN IF NOT EXISTS, but the runner (app/api/src/db/migrate.ts) protects
-- this twice over:
--   1. Filename-keyed dedup — migrate.ts:35 skips any file already listed in
--      the `migrations` table, so a second run never re-executes this file.
--   2. Duplicate-column rescue — migrate.ts:49-54 catches "duplicate column"
--      and "already exists", logs, marks the file applied, and continues
--      instead of throwing.
-- So re-application is a no-op by dedup, and even a forced re-run degrades to a
-- logged skip rather than a startup crash. Documented here so the next person
-- does not have to re-derive it.

ALTER TABLE base_sync_cursor
  ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE base_sync_cursor
  ADD COLUMN last_success_at INTEGER NOT NULL DEFAULT 0;

UPDATE base_sync_cursor
   SET last_attempt_at = last_synced_at,
       last_success_at = last_synced_at
 WHERE id = 1;
