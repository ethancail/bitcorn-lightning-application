import { db } from "../db";

export type RebalanceCostType = "circular" | "keysend" | "loop_out" | "loop_in" | "manual";

/**
 * Log a rebalance cost for true net accounting.
 * Call when recording any rebalance cost — Loop Out (current steady-state path),
 * legacy circular rebalance, treasury push (keysend), or manual channel open
 * costs. The cost ledger captures all sources for accurate `net_sats` accounting.
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
