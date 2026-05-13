-- Migration 041: add first_seen_at to lnd_channels for subscription
-- status discrimination.
--
-- Source of truth:
--   - specs/2026-05-11-subscription-stage-5a-jwt-fix-and-member-ui.md §5.2
--     (Case C `not_yet_allocated` vs Case D `missing` distinguished by
--      channel age, 60s threshold)
--
-- The Stage 5a member-side Subscription panel distinguishes "transient
-- — your subscription is still being allocated" from "operational
-- anomaly — the row should exist." Both are "no subscription row,
-- lane purpose is in-scope," but the age of the underlying channel
-- discriminates them. Without an explicit first-seen timestamp we'd
-- have to approximate via `updated_at`, which the sync loop bumps on
-- every tick.
--
-- Backfill: for channels that existed before this migration we don't
-- have the true first-seen timestamp, so seed from `updated_at`. This
-- has a subtle implication worth being explicit about: `updated_at`
-- gets bumped every 15s sync tick, so it's effectively "very recent"
-- at migration time. That means existing in-scope channels without
-- subscription rows initially surface as Case C (transient,
-- not_yet_allocated) for 60s post-migration, then Case D (missing,
-- operational anomaly) thereafter.
--
-- This is intentional and correct. The first_seen_at column is only
-- read by computeSubscriptionStatusForPubkey when no subscription row
-- exists for the pubkey (Case B/C/D/E disambiguation); Case A — the
-- vast-majority path on a healthy treasury — never consults it. For
-- in-scope channels that already have rows, the migration is a no-op
-- semantically.
--
-- The only "false-positive Case D" path requires: an in-scope channel
-- that lacks a subscription row at migration time. That's already an
-- operational anomaly (discoverAndAllocateNewMembers runs every sync
-- tick and should have allocated), so surfacing it as Case D is the
-- correct behavior — it's what the operator needs to know about.

-- Edge case worth flagging for future work: on a treasury that has
-- never run first-run-ack (POST /api/admin/subscription/acknowledge-
-- first-run), the allocator is gated off, so all in-scope channels
-- lack rows by design. They'd all surface as Case C → Case D under
-- this migration. The right surface for that state would be a Case F
-- ("system not yet activated") that overrides Cases C/D — out of
-- 5a.2 scope; tracked as follow-up.

ALTER TABLE lnd_channels ADD COLUMN first_seen_at INTEGER;

UPDATE lnd_channels SET first_seen_at = updated_at WHERE first_seen_at IS NULL;
