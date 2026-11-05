// The effective member swap limits per direction, pure (drive-mode P1 item 6):
// the stricter of Bitcorn's env limits and loopd's terms. Its own module so the
// advisor can use it without loading the Lightning clients; swapLimits.ts
// re-exports it.

import { ENV } from "../config/env";

export type SwapDirection = "loop_out" | "loop_in";
export type LoopTermsLike = { min_swap_amount: number; max_swap_amount: number };

export function envLimits(direction: SwapDirection) {
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

