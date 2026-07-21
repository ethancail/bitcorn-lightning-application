// Subscription-revenue aggregates for the treasury dashboard widget
// and the AdminMembers revenue columns.
//
// Source of truth:
//   - app/api/src/db/migrations/036_member_subscription.sql
//     §subscription_payment (ledger), §subscription_policy (price/period)
//
// Every sum filters kind = 'onchain'. The grandfather admin_override
// sentinel rows carry amount_sats = 0 (see adminMembersHandler.ts —
// same exclusion for the last-payment column); operator overrides that
// credit time also aren't on-chain revenue. Counting either would put
// phantom rows in payment counts and skew nothing-or-zero sums.
//
// "Paying" = has actually paid: at least one CONFIRMED on-chain row in
// the ledger (kind='onchain', confirmed_at set). Deliberately NOT
// current_tier = 'current' — that tier includes fresh-grace members
// inside their onboarding window (tierDispatch.ts) who have never made
// a payment, which inflated the count and the entitlement projection.
// Note the flip side: a lapsed member who paid at least once still
// counts as paying here. member_count is all subscription rows
// (enrolled members), giving the widget's "N of M".
//
// Like autoPayAlertStore.ts, functions take the DB connection as a
// parameter (plus a clock) so tests can run against an in-memory
// better-sqlite3 with the real migration schema.

import type Database from "better-sqlite3";

export interface MemberRevenueRow {
  /** Lowercased — subscription rows store lowercased pubkeys. */
  member_pubkey: string;
  total_sats: number;
  /** SUM over rows that captured a USD price; 0 when none did. */
  total_usd_cents: number;
  payment_count: number;
  /** Confirmed within the current period_days window. */
  window_sats: number;
  window_payment_count: number;
}

export interface SubscriptionRevenueResponse {
  fetched_at: number;
  policy: { price_sats: number; period_days: number };
  /** Start of the current recurring window: now − period_days. */
  window_start: number;
  totals: {
    total_earned_sats: number;
    total_earned_usd_cents: number;
    payment_count: number;
    /** paying_member_count × policy.price_sats — expected per cycle. */
    recurring_entitlement_sats: number;
    /** Confirmed on-chain sats inside the current window. */
    recurring_actual_sats: number;
    /** Members with ≥1 confirmed on-chain payment (has actually paid). */
    paying_member_count: number;
    member_count: number;
  };
  /** Sorted by total_sats DESC. */
  members: MemberRevenueRow[];
}

const MS_PER_DAY = 86_400_000;

interface PolicyRow {
  price_sats: number;
  period_days: number;
}

interface AllTimeRow {
  member_pubkey: string;
  total_sats: number;
  total_usd_cents: number;
  payment_count: number;
}

interface WindowRow {
  member_pubkey: string;
  window_sats: number;
  window_payment_count: number;
}

/**
 * Returns per-member revenue sums plus the dashboard aggregates.
 * Pure of HTTP — caller wires to a 200 response.
 */
export function computeSubscriptionRevenueForTreasury(
  db: Database.Database,
  nowMs: number,
): SubscriptionRevenueResponse {
  const policy = db
    .prepare(`SELECT price_sats, period_days FROM subscription_policy WHERE id = 1`)
    .get() as PolicyRow | undefined;
  if (!policy) {
    throw new Error(
      "subscription_policy row not found — migration 036 should have seeded it",
    );
  }

  const windowStart = nowMs - policy.period_days * MS_PER_DAY;

  // All-time per-member sums. SUM() skips NULL usd-cents rows on its
  // own; COALESCE covers members where every row predates USD capture.
  const allTime = db
    .prepare(
      `SELECT member_pubkey,
              SUM(amount_sats) AS total_sats,
              COALESCE(SUM(amount_usd_cents_at_receipt), 0) AS total_usd_cents,
              COUNT(*) AS payment_count
       FROM subscription_payment
       WHERE kind = 'onchain'
       GROUP BY member_pubkey
       ORDER BY total_sats DESC, member_pubkey ASC`,
    )
    .all() as AllTimeRow[];

  // Current-window sums. Keyed on confirmed_at: "received this period"
  // means money that actually confirmed inside the window; pending
  // rows (confirmed_at NULL) stay out until they confirm.
  const windowRows = db
    .prepare(
      `SELECT member_pubkey,
              SUM(amount_sats) AS window_sats,
              COUNT(*) AS window_payment_count
       FROM subscription_payment
       WHERE kind = 'onchain'
         AND confirmed_at IS NOT NULL
         AND confirmed_at >= ?
       GROUP BY member_pubkey`,
    )
    .all(windowStart) as WindowRow[];
  const windowByPubkey = new Map(windowRows.map((r) => [r.member_pubkey, r]));

  const members: MemberRevenueRow[] = allTime.map((r) => {
    const w = windowByPubkey.get(r.member_pubkey);
    return {
      member_pubkey: r.member_pubkey,
      total_sats: r.total_sats,
      total_usd_cents: r.total_usd_cents,
      payment_count: r.payment_count,
      window_sats: w?.window_sats ?? 0,
      window_payment_count: w?.window_payment_count ?? 0,
    };
  });

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM subscription) AS member_count,
         (SELECT COUNT(DISTINCT member_pubkey)
            FROM subscription_payment
           WHERE kind = 'onchain' AND confirmed_at IS NOT NULL)
           AS paying_member_count`,
    )
    .get() as { member_count: number; paying_member_count: number };

  return {
    fetched_at: nowMs,
    policy: { price_sats: policy.price_sats, period_days: policy.period_days },
    window_start: windowStart,
    totals: {
      total_earned_sats: members.reduce((s, m) => s + m.total_sats, 0),
      total_earned_usd_cents: members.reduce((s, m) => s + m.total_usd_cents, 0),
      payment_count: members.reduce((s, m) => s + m.payment_count, 0),
      recurring_entitlement_sats: counts.paying_member_count * policy.price_sats,
      recurring_actual_sats: members.reduce((s, m) => s + m.window_sats, 0),
      paying_member_count: counts.paying_member_count,
      member_count: counts.member_count,
    },
    members,
  };
}
