import { db } from "../db";

export type RebalanceCostType = "keysend" | "loop_out" | "loop_in" | "manual";

/**
 * Log a rebalance cost for true net accounting.
 * Call when recording any rebalance cost — today that is Loop Out
 * (rebalance-loop.ts). Rows written earlier can carry the types of removed paths
 * (e.g. 'circular'); every reader sums all rows regardless of type, so they
 * still count toward `net_sats` and the daily loss cap.
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
