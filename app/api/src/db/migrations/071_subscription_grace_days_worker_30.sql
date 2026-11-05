-- Migration 071: the Tier 1 lock moves from paid_through + 7 days to + 30 days
--
-- Source: bitcorn-research specs/2026-11-05-membership-gating-spec.md T2
-- (decision D4; ruling R9, third reading: a guarded migration).
--
-- GUARDED. The value changes only if it is still migration 036's default, 7.
-- A value an operator set by hand to anything else is left alone.
--
-- grace_days_routing (30) and grace_days_close (60) are not changed; they are
-- left to Stage 6 (D4(a)). With worker = 30 and routing = 30, the tier dispatch
-- returns `current` up to paid_through + 30 and `worker_lapsed` becomes
-- unreachable; `routing_lapsed` runs from + 30 to + 60. That empty window is
-- accepted (R3).
--
-- Runs at startup, before the sync loop or any /token call can recompute a
-- tier (index.ts bootSideEffects: runMigrations() precedes the loop).

UPDATE subscription_policy
   SET grace_days_worker = 30,
       updated_at = (strftime('%s','now') * 1000)
 WHERE id = 1
   AND grace_days_worker = 7;
