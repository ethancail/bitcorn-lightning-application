// §5 Tier dispatch — computes `current_tier` for every subscription
// row and persists it for fast read.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §5
//
// Dispatch order:
//
//   if NOT EXISTS (SELECT 1 FROM subscription_payment
//                  WHERE member_pubkey = m.member_pubkey
//                    AND period_extension_days > 0)              → prepay
//   elif now() <= paid_through                                    → current
//   elif now() <= paid_through + grace_days_worker                → current  (Tier 1 grace)
//   elif now() <= paid_through + grace_days_routing               → worker_lapsed
//   elif now() <= paid_through + grace_days_close                 → routing_lapsed
//   else                                                          → close_due
//
// There is no pre-payment grace. A row that has never been credited time
// computes `prepay` from the moment it exists, so a never-paid node holds a
// payment-scope token from its first /token call (membership-gating D1,
// bitcorn-research specs/2026-11-05-membership-gating-spec.md T1). Migration
// 042's fresh-grace window (grace_days_fresh) is no longer read here; the
// column stays, because the status response still reports
// `grace.fresh_until` for older member nodes.
//
// The prepay test is `NOT EXISTS` against subscription_payment with
// `period_extension_days > 0`, not `last_payment_txid IS NULL` against
// subscription. This was a Stage 2 architectural call (decision
// record: 2026-05-08-subscription-stage-2-architectural-deltas.md,
// point 6): grandfathered members get a sentinel admin_override row
// at backfill time with `period_extension_days = 0`.
//
// The `period_extension_days > 0` filter means the sentinel alone does
// not count as a payment: it marks "this member existed at flip-day" but
// credits no time. A grandfathered row reaches the paid ladder through
// the founding-member credit (migration 072, and grandfather-mode
// allocation in addressAllocator.ts), an admin_override row that does
// credit time, written together with a move of paid_through. Real
// payments (`kind='onchain'` or operator overrides that credit time)
// have `period_extension_days > 0` and set `hasAnyPaymentRow=true`.
//
// Run from the detector after the UTXO scan. Cheap to run every 15s —
// it's an UPDATE per row keyed on the indexed primary.

import { db } from "../db";
import type { SubscriptionPolicy } from "./policy";

export type TierValue =
  | "prepay"
  | "current"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due";

const MS_PER_DAY = 86_400_000;

/**
 * Pure-function form of the dispatch — given the per-member inputs,
 * return the tier. No I/O. Called by the row-by-row recompute below
 * but exposed for unit testing.
 */
export function computeTier(args: {
  hasAnyPaymentRow: boolean;
  paidThroughMs: number;
  graceDaysWorker: number;
  graceDaysRouting: number;
  graceDaysClose: number;
  nowMs: number;
}): TierValue {
  if (!args.hasAnyPaymentRow) return "prepay";
  const t = args.paidThroughMs;
  if (args.nowMs <= t) return "current";
  if (args.nowMs <= t + args.graceDaysWorker * MS_PER_DAY) return "current";
  if (args.nowMs <= t + args.graceDaysRouting * MS_PER_DAY) return "worker_lapsed";
  if (args.nowMs <= t + args.graceDaysClose * MS_PER_DAY) return "routing_lapsed";
  return "close_due";
}

export interface RecomputeSummary {
  rows_seen: number;
  transitions: Array<{ member_pubkey: string; from: TierValue; to: TierValue }>;
}

/**
 * Iterates every `subscription` row, recomputes `current_tier`
 * per the §5 ladder, and persists the new value when it changes.
 * Returns a summary including any tier transitions for observability.
 */
export function recomputeAllTiers(
  policy: Pick<
    SubscriptionPolicy,
    | "grace_days_worker"
    | "grace_days_routing"
    | "grace_days_close"
  >,
): RecomputeSummary {
  const summary: RecomputeSummary = { rows_seen: 0, transitions: [] };
  const now = Date.now();

  // Single-query join: for each subscription, EXISTS check on payment.
  // EXISTS keeps the result boolean instead of materialising the count.
  //
  // `period_extension_days > 0` filters out sentinel admin_override
  // rows (grandfather backfill markers with extension=0 that credit no
  // time). See the note above: without this filter, a sentinel-only row
  // would enter the paid-tier ladder with paid_through at its allocation
  // moment, and land in a lapsed tier set by how long ago the backfill ran.
  const rows = db
    .prepare(
      `SELECT
         s.member_pubkey,
         s.paid_through,
         s.current_tier AS old_tier,
         EXISTS (
           SELECT 1 FROM subscription_payment p
           WHERE p.member_pubkey = s.member_pubkey
             AND p.period_extension_days > 0
         ) AS has_payment_row
       FROM subscription s`,
    )
    .all() as Array<{
      member_pubkey: string;
      paid_through: number;
      old_tier: TierValue;
      has_payment_row: 0 | 1;
    }>;

  const updateTier = db.prepare(
    "UPDATE subscription SET current_tier = ? WHERE member_pubkey = ?",
  );

  for (const row of rows) {
    summary.rows_seen++;
    const newTier = computeTier({
      hasAnyPaymentRow: row.has_payment_row === 1,
      paidThroughMs: row.paid_through,
      graceDaysWorker: policy.grace_days_worker,
      graceDaysRouting: policy.grace_days_routing,
      graceDaysClose: policy.grace_days_close,
      nowMs: now,
    });
    if (newTier !== row.old_tier) {
      updateTier.run(newTier, row.member_pubkey);
      summary.transitions.push({
        member_pubkey: row.member_pubkey,
        from: row.old_tier,
        to: newTier,
      });
    }
  }

  return summary;
}
