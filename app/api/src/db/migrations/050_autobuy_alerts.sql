-- Migration 050: Auto-Buy failure alerts (Phase 2)
--
-- Implements specs/2026-06-05-currency-adaptive-autobuy-phase-2.md §1.
-- Phase 1 (migration 049) made the Auto-Buy currency-adaptive; Phase 2 turns
-- its failures into active, stored in-app notifications with dedup, dismissal,
-- and a 30-day history.
--
-- Why a NEW table rather than extending the existing TreasuryAlert surface:
-- getTreasuryAlerts() is computed-on-read (it recomputes an in-memory array
-- from live state every call — no storage, no acknowledged_at, no dedup, no
-- history). It physically cannot represent (a) a consecutive_count that
-- increments across ticks, (b) a dismissal that survives reload, or (c) a
-- 30-day log of resolved/dismissed alerts. Two of the five Phase 2 scenarios
-- (auth-pause, rate-limit-at-listAccounts) also leave no autobuy_runs row to
-- recompute from. A stored table is therefore required, not merely preferred.
-- This table is parallel to getTreasuryAlerts(); that surface is left
-- untouched. The two share only their visual language (CSS classes, the
-- three-level severity vocabulary), not storage or endpoints.
--
-- Numbering note (mirrors 049): this release is cut off `main`, which is at
-- migration 042 + the 049 hotfix line; `develop` has reserved 043-048 for the
-- unreleased stablecoin-rail (BASE) work. 050 is the next contiguous integer
-- above 049 and stays above the reserved 043-048 block, so the two lines never
-- collide when BASE later merges to main. The runner (db/migrate.ts) discovers
-- files by name and sorts lexicographically; it never reasons about
-- contiguity, so the temporary gap on main is harmless.
--
-- Idempotency: db/migrate.ts applies each file with a single db.exec() and
-- marks the file applied; on an error containing "already exists"/"duplicate
-- column" it logs-and-marks rather than failing. Every statement below is
-- guarded with IF NOT EXISTS so a re-run of the whole file is a safe no-op.
--
-- No backfill. Phase 2 is forward-looking: this table starts empty and fills
-- only from scheduler ticks after the migration applies. Pre-existing
-- autobuy_runs failures do NOT retroactively create alerts.

CREATE TABLE IF NOT EXISTS autobuy_alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT    NOT NULL,   -- canonical AUTOBUY_* type (spec §2)
  severity          TEXT    NOT NULL CHECK (severity IN ('warning','critical')),
  status            TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','resolved','dismissed')),
  consecutive_count INTEGER NOT NULL DEFAULT 1,  -- recurrences while active
  latest_run_id     INTEGER,           -- autobuy_runs.id; NULL for run-less signals (auth/rate-limit)
  context_json      TEXT,              -- JSON blob, scenario-specific (spec §2 "context")
  created_at        INTEGER NOT NULL,  -- epoch seconds, first occurrence
  updated_at        INTEGER NOT NULL,  -- epoch seconds, last occurrence or state change
  resolved_at       INTEGER,           -- set when auto-cleared (status -> 'resolved')
  dismissed_at      INTEGER            -- set when user dismisses (status -> 'dismissed')
);

-- Fast "is there an active alert of this type?" — drives §2 create-or-dedup
-- and the §5 GET /api/autobuy/alerts active-list (status='active').
CREATE INDEX IF NOT EXISTS idx_autobuy_alerts_type_status
  ON autobuy_alerts(type, status);

-- 30-day history window scan (§3, §4c, GET /api/autobuy/alerts/history).
CREATE INDEX IF NOT EXISTS idx_autobuy_alerts_created
  ON autobuy_alerts(created_at);
