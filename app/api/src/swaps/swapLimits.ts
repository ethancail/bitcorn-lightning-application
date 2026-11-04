// The effective member swap limits, read rather than hard-coded (drive-mode
// spec P1 item 6, §3.3; D1.8).
//
// Per direction: the stricter of Bitcorn's env limits and loopd's live terms —
// the minimum is the larger of the two minimums, the maximum the smaller of the
// two maximums — exactly the bounds checkMemberLoopOutPolicy and
// checkMemberLoopInPolicy enforce (swapPolicy.ts §1–2), so a UI that offers
// these figures offers nothing the policy refuses for bounds. With loopd
// unreachable, the env limits alone, and loop_available: false.
//
// The daily remaining amount counts the member's swaps of the last 24 hours in
// the same statuses the policy counts.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLoopInTerms, getLoopOutTerms } from "../lightning/loop";
import { getHubChannel } from "../lightning/hubChannel";

export type SwapDirection = "loop_out" | "loop_in";
export type LoopTermsLike = { min_swap_amount: number; max_swap_amount: number };

function envLimits(direction: SwapDirection) {
  return direction === "loop_out"
    ? { min: ENV.memberMinWithdrawalSat, max: ENV.memberMaxWithdrawalSat, daily: ENV.memberMaxDailyWithdrawalSat }
    : { min: ENV.memberMinRefillSat, max: ENV.memberMaxRefillSat, daily: ENV.memberMaxDailyRefillSat };
}

/** The stricter of env and loopd's terms; env alone when terms are null. */
export function effectiveLimits(
  direction: SwapDirection,
  terms: LoopTermsLike | null,
): { min_sats: number; max_sats: number } {
  const env = envLimits(direction);
  if (!terms) return { min_sats: env.min, max_sats: env.max };
  return {
    min_sats: Math.max(env.min, terms.min_swap_amount),
    max_sats: Math.min(env.max, terms.max_swap_amount),
  };
}

function dailyUsed(nodePubkey: string, direction: SwapDirection): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = ?
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, direction, Date.now() - 86_400_000) as { total: number };
  return row.total;
}

export type DirectionLimits = {
  min_sats: number;
  max_sats: number;
  daily_max_sats: number;
  daily_remaining_sats: number;
};

export type MemberSwapLimits = {
  loop_available: boolean;
  loop_out: DirectionLimits & {
    /** The most a withdrawal can be right now and pass the pre-quote policy
     *  (drive-mode P1 item 7): the effective maximum, today's remaining daily
     *  amount, and the hub channel's local balance less the swap-only buffer
     *  (R18(6)) — the same arithmetic as checkMemberLoopOutPolicy with no fee.
     *  Below min_sats, nothing can be withdrawn now. The quote's fee is not in
     *  it: an amount within one fee of it can still be refused by the fee phase
     *  after the quote (the plan's stated residual), before any swap starts. */
    available_now_sats: number;
  };
  loop_in: DirectionLimits;
};

async function termsOrNull(fetch: () => Promise<LoopTermsLike>): Promise<LoopTermsLike | null> {
  try {
    return await fetch();
  } catch {
    return null;
  }
}

export async function getMemberSwapLimits(nodePubkey: string): Promise<MemberSwapLimits> {
  const [outTerms, inTerms] = await Promise.all([termsOrNull(getLoopOutTerms), termsOrNull(getLoopInTerms)]);
  const direction = (d: SwapDirection, terms: LoopTermsLike | null): DirectionLimits => {
    const daily = envLimits(d).daily;
    return {
      ...effectiveLimits(d, terms),
      daily_max_sats: daily,
      daily_remaining_sats: Math.max(0, daily - dailyUsed(nodePubkey, d)),
    };
  };
  const loopOut = direction("loop_out", outTerms);
  const hub = getHubChannel();
  const hubSpendable = hub ? Math.max(0, hub.local_balance_sat - ENV.swapMemberRoutingBufferSat) : 0;
  return {
    loop_available: outTerms != null && inTerms != null,
    loop_out: {
      ...loopOut,
      available_now_sats: Math.max(0, Math.min(loopOut.max_sats, loopOut.daily_remaining_sats, hubSpendable)),
    },
    loop_in: direction("loop_in", inTerms),
  };
}
