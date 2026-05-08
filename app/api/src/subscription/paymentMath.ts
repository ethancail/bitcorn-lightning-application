// Pure math helpers for subscription payment processing.
// No I/O, no dependencies on db / lnd / config. Easy to unit-test.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §4

export interface SubscriptionPolicySnapshot {
  price_sats: number;
  period_days: number;
  underpay_tolerance_pct: number;
}

export type CreditOutcome =
  | { kind: "credit"; period_extension_days: number }
  | { kind: "pending_attribution"; reason: string };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decides whether an incoming receipt is a creditable payment or
 * lands in the pending-attribution bucket per spec §4 / §4.1.
 *
 * Below `underpay_tolerance_pct` of `price_sats` → pending bucket.
 * At or above tolerance → credit pro-rata, floor on whole days.
 *
 * Worked examples from the spec:
 * - amount = 100,000 sats, price = 50,000, period = 30 → 60 days
 * - amount = 47,500 sats (95% of price), period = 30 → 28 days (floor)
 * - amount = 47,499 sats → pending bucket
 */
export function attributePayment(
  amountSats: number,
  policy: SubscriptionPolicySnapshot,
): CreditOutcome {
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    return { kind: "pending_attribution", reason: "non-positive or non-finite amount" };
  }
  const tolerance = (policy.price_sats * policy.underpay_tolerance_pct) / 100;
  if (amountSats < tolerance) {
    return {
      kind: "pending_attribution",
      reason: `below ${policy.underpay_tolerance_pct}% tolerance (${amountSats} < ${Math.ceil(tolerance)} sats)`,
    };
  }
  // Pro-rata: full periods + floor of partial period.
  // periodExtensionDays = floor((amountSats / priceSats) * periodDays)
  const exactDays = (amountSats / policy.price_sats) * policy.period_days;
  return { kind: "credit", period_extension_days: Math.floor(exactDays) };
}

/**
 * Computes the new `paid_through` value after a creditable payment per
 * spec §4.2. Branches on whether the member is currently within their
 * paid window or already lapsed.
 *
 * - Early payment (now <= currentPaidThrough): stack forward from
 *   currentPaidThrough.
 * - Late payment OR pre-payment first-ever (now > currentPaidThrough,
 *   i.e. currently lapsed or grandfathered/prepay sentinel): reset
 *   from now.
 *
 * Pre-payment first-ever is naturally handled by the late-payment
 * branch because `paid_through = created_at` < now() at first payment.
 */
export function computeNewPaidThrough(
  currentPaidThroughMs: number,
  periodExtensionDays: number,
  nowMs: number,
): number {
  const extensionMs = periodExtensionDays * MS_PER_DAY;
  if (nowMs <= currentPaidThroughMs) {
    return currentPaidThroughMs + extensionMs;
  }
  return nowMs + extensionMs;
}
