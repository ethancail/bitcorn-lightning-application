/**
 * GET /api/member/costs — what this node paid in fees over the last 30 days
 * (drive-mode P2 item 14; the record :48, "costs over the last 30 days").
 * Read-only.
 *
 * Two sources, both local:
 *   - payment fees: Lightning sends that SUCCEEDED and settled in the window
 *     (network_payments). Failed, expired and pending sends pay no fee, which
 *     is P1's fee-state split (network-payments.ts feeStateOf); a receive pays
 *     none.
 *   - swap fees: this node's swaps that COMPLETED in the window, their
 *     actual_fee_sat, per direction — Withdraw (loop_out) and Top Up (loop_in).
 *     A swap's completion is its last update (swapPoller.ts).
 *
 * No subscription line and no treasury call (R27(9)).
 */

import { db } from "../db";

const WINDOW_MS = 30 * 86_400_000;

export interface MemberCosts {
  since_ms: number;
  payment_fees_sat: number;
  withdraw_fees_sat: number;
  topup_fees_sat: number;
  total_sat: number;
}

export function getMemberCosts(nodePubkey: string, nowMs: number = Date.now()): MemberCosts {
  const since = nowMs - WINDOW_MS;
  const payments = db.prepare(`
    SELECT COALESCE(SUM(fee_sats), 0) AS fees FROM network_payments
    WHERE direction = 'send' AND status = 'succeeded' AND settled_at >= ?
  `).get(since) as { fees: number };
  const swaps = db.prepare(`
    SELECT swap_type, COALESCE(SUM(actual_fee_sat), 0) AS fees FROM swap_requests
    WHERE node_pubkey = ? AND status = 'completed' AND updated_at >= ?
    GROUP BY swap_type
  `).all(nodePubkey, since) as Array<{ swap_type: string; fees: number }>;
  const swapFees = (type: string) => swaps.find((s) => s.swap_type === type)?.fees ?? 0;
  const withdraw = swapFees("loop_out");
  const topup = swapFees("loop_in");
  return {
    since_ms: since,
    payment_fees_sat: payments.fees,
    withdraw_fees_sat: withdraw,
    topup_fees_sat: topup,
    total_sat: payments.fees + withdraw + topup,
  };
}
