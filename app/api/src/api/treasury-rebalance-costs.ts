import { db } from "../db";

export type RebalanceCostType = "circular" | "loop_out" | "loop_in" | "manual";

/**
 * Log a rebalance cost for true net accounting.
 * Call after circular rebalance (payViaRoutes/payViaPaymentRequest internal),
 * loop out/in, or when recording manual channel open costs.
 */
export function insertRebalanceCost(
  type: RebalanceCostType,
  tokens: number,
  feePaidSats: number,
  relatedChannel?: string | null
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO treasury_rebalance_costs
     (type, tokens, fee_paid_sats, related_channel, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(type, tokens, feePaidSats, relatedChannel ?? null, now);
}
