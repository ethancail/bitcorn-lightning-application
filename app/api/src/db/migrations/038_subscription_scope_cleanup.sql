-- Migration 038: One-shot cleanup of Stage 2 over-broad subscription
-- backfill. Per spec §3.0 + §10 step 3a, subscription scope is bounded
-- by lane purpose: only `merchant_lane` and `farmer_lane` peers are in
-- scope. `external_peer` (curated list incl. ACINQ; or contact-tagged
-- as such) and `unclassified` peers must not have subscription rows.
--
-- Stage 2 backfill predated this scope rule and grandfathered every
-- channel peer. This migration removes those over-broad rows.
--
-- Order of operations: subscription_payment.member_pubkey FK is
-- ON DELETE RESTRICT, so sentinel admin_override rows must be
-- deleted first, then the subscription rows.
--
-- Idempotent: a fresh DB has no rows to remove and the deletes are
-- no-ops.
--
-- Lane-purpose check encoded in SQL — must stay in sync with
-- app/api/src/subscription/lanePurpose.ts and the frontend
-- equivalents (transform.ts, App.tsx). If the curated external-pubkey
-- list grows, update both this migration's VALUES clause AND the
-- three TS copies. The going-forward scope check (backfill +
-- discoverAndAllocateNewMembers) uses the TS helper, so existing
-- DBs that ran this migration but later added a peer to the curated
-- list will not have that peer auto-cleaned — re-run a future
-- cleanup migration if/when the list changes materially.

-- Step 1: identify out-of-scope members and remove their sentinel
-- admin_override ledger rows. Out-of-scope = in the curated external
-- list, OR contact has external/external-peer tag, OR contact has
-- no merchant/farmer tag at all (covers both "no contact row"
-- = unclassified and "tagged but not as a member role" = unclassified).
WITH external_pubkeys(pubkey) AS (
  -- Curated external-routing-peer list. Matches EXTERNAL_PUBKEYS in
  -- app/web/src/components/liquidity/types.ts.
  VALUES ('03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f') -- ACINQ
),
out_of_scope AS (
  SELECT s.member_pubkey
  FROM subscription s
  LEFT JOIN contacts c ON c.pubkey = s.member_pubkey
  WHERE
    -- Curated external-routing peer
    s.member_pubkey IN (SELECT pubkey FROM external_pubkeys)
    -- Tagged external (in either short form or lane-purpose form)
    OR LOWER(',' || COALESCE(c.tags, '') || ',') LIKE '%,external,%'
    OR LOWER(',' || COALESCE(c.tags, '') || ',') LIKE '%,external-peer,%'
    -- Otherwise: keep only peers whose tags include a member-role
    -- value. Anyone else (no contact row, or tagged but not as a
    -- member) is unclassified and out of scope.
    OR (
      LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,merchant,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,merchant-lane,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,farmer,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,farmer-lane,%'
    )
)
DELETE FROM subscription_payment
WHERE member_pubkey IN (SELECT member_pubkey FROM out_of_scope);

-- Step 2: same selection, drop the subscription rows themselves now
-- that the FK-protected sentinels are gone.
WITH external_pubkeys(pubkey) AS (
  VALUES ('03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f')
),
out_of_scope AS (
  SELECT s.member_pubkey
  FROM subscription s
  LEFT JOIN contacts c ON c.pubkey = s.member_pubkey
  WHERE
    s.member_pubkey IN (SELECT pubkey FROM external_pubkeys)
    OR LOWER(',' || COALESCE(c.tags, '') || ',') LIKE '%,external,%'
    OR LOWER(',' || COALESCE(c.tags, '') || ',') LIKE '%,external-peer,%'
    OR (
      LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,merchant,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,merchant-lane,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,farmer,%'
      AND LOWER(',' || COALESCE(c.tags, '') || ',') NOT LIKE '%,farmer-lane,%'
    )
)
DELETE FROM subscription
WHERE member_pubkey IN (SELECT member_pubkey FROM out_of_scope);
