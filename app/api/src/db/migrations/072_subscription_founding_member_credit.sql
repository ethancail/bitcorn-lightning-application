-- Migration 072: credit every grandfathered, never-paid row one paid period
--
-- Source: bitcorn-research specs/2026-11-05-membership-gating-spec.md T3
-- (decision D2; rulings R1, R2; pass 10 items 3 and E).
--
-- WHY THIS EXISTS. Removing fresh grace (T1) makes a row with no payment that
-- credits time compute `prepay`. Grandfathered rows carry only the backfill
-- sentinel (an admin_override with period_extension_days = 0), which credits
-- nothing, so without this credit every grandfathered member would lose full
-- scope on the first recompute after the update.
--
-- THE CREDIT, per selected row, in ONE transaction:
--   - an admin_override payment row: period_extension_days = period_days,
--     amount_sats = 0, received_at = the credit time, admin_reason
--     'Founding member credit' (members see this text in payment history);
--   - paid_through = the credit time + period_days days, in milliseconds.
-- Both or neither: a credit row with an unmoved paid_through would put the row
-- on the paid ladder with paid_through at its allocation moment, i.e. straight
-- into a lapsed tier (spec §0.2), and a lapsed tier fires auto-pay.
--
-- current_tier is NOT written here; the next recompute sets it (item 3).
-- last_payment_at and last_payment_txid stay null: no on-chain payment
-- happened (item E).
--
-- THE TRANSACTION IS WRITTEN HERE because the runner does not wrap a file in
-- one: migrate.ts runs db.exec(sql), then records the file in a separate
-- statement. If any statement below fails, the boot stops before COMMIT and
-- the open transaction is discarded with the connection.
--
-- THE SELECTION: rows that have the grandfather sentinel and NO payment row
-- crediting time. Running this file a second time selects nothing, so a crash
-- between COMMIT and the runner's bookkeeping insert is harmless.
--
-- Runs at startup, before any tier recompute (index.ts bootSideEffects), so no
-- selected row is ever recomputed without its credit.

BEGIN;

-- migrate.ts treats any error containing "already exists" as "already applied"
-- and records the file as run. A CREATE that hit a leftover temp table would
-- take that path and skip the credit, so the name is cleared first.
DROP TABLE IF EXISTS temp.founding_credit;

CREATE TEMP TABLE founding_credit AS
  SELECT s.member_pubkey                                   AS member_pubkey,
         CAST(strftime('%s','now') AS INTEGER) * 1000      AS credit_at,
         (SELECT period_days FROM subscription_policy WHERE id = 1) AS period_days
    FROM subscription s
   WHERE EXISTS (
           SELECT 1 FROM subscription_payment p
            WHERE p.member_pubkey = s.member_pubkey
              AND p.kind = 'admin_override'
              AND p.admin_reason = 'Stage 2 grandfather backfill at flip-day'
         )
     AND NOT EXISTS (
           SELECT 1 FROM subscription_payment p
            WHERE p.member_pubkey = s.member_pubkey
              AND p.period_extension_days > 0
         );

INSERT INTO subscription_payment (
    member_pubkey, amount_sats, received_at,
    period_extension_days, kind, admin_reason
)
SELECT member_pubkey, 0, credit_at,
       period_days, 'admin_override', 'Founding member credit'
  FROM founding_credit;

UPDATE subscription
   SET paid_through = (
         SELECT f.credit_at + f.period_days * 86400000
           FROM founding_credit f
          WHERE f.member_pubkey = subscription.member_pubkey
       )
 WHERE member_pubkey IN (SELECT member_pubkey FROM founding_credit);

DROP TABLE founding_credit;

COMMIT;
