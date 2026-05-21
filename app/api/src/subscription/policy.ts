// subscription_policy single-row reader.
//
// The policy row is seeded by migration 036 with the canonical
// 50,000 sats / 30 days / 7-30-60 grace / 95% tolerance defaults.
// Migration 042 adds grace_days_fresh (default 30) — a pre-payment
// onboarding window during which fresh prepay members are treated as
// `current` so they have full-scope access while evaluating the service.
// Values can be edited via /api/admin/subscription-policy (Stage 5).

import { db } from "../db";
import type { SubscriptionPolicySnapshot } from "./paymentMath";

export interface SubscriptionPolicy extends SubscriptionPolicySnapshot {
  price_sats: number;
  period_days: number;
  grace_days_fresh: number;
  grace_days_worker: number;
  grace_days_routing: number;
  grace_days_close: number;
  underpay_tolerance_pct: number;
  updated_at: number;
  first_run_acknowledged_at: number | null;
}

export function getSubscriptionPolicy(): SubscriptionPolicy {
  const row = db
    .prepare(
      `SELECT price_sats, period_days,
              grace_days_fresh,
              grace_days_worker, grace_days_routing, grace_days_close,
              underpay_tolerance_pct, updated_at, first_run_acknowledged_at
       FROM subscription_policy WHERE id = 1`,
    )
    .get() as SubscriptionPolicy | undefined;
  if (!row) {
    throw new Error(
      "subscription_policy row not found — migration 036 should have seeded it",
    );
  }
  return row;
}
