import { db } from "../db";
import { getCapitalPolicy } from "../api/treasury-capital-policy";

/** Thrown when the daily loss cap would be exceeded. Results in a 429 response. */
export class DailyLossCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyLossCapError";
  }
}

/**
 * Returns total rebalance fees paid in the last 24 hours.
 * This is the primary metric for the daily loss cap.
 */
export function getDailyLossSats(): number {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(fee_paid_sats), 0) AS v
       FROM treasury_rebalance_costs
       WHERE created_at >= ?`
    )
    .get(since24h) as { v: number };
  return row?.v ?? 0;
}

/**
 * Asserts that the daily loss cap has not been (or would not be) exceeded.
 * Call before any operation that incurs fees (rebalance, channel close).
 *
 * @param additionalSats - Expected spend of the pending operation (e.g. max_fee_sats).
 *                         Pass 0 to check current state only.
 * @throws DailyLossCapError if cap is exceeded or would be exceeded.
 */
export function assertDailyLossCapNotExceeded(additionalSats: number = 0): void {
  const policy = getCapitalPolicy();
  const current = getDailyLossSats();
  const projected = current + additionalSats;

  if (projected >= policy.max_daily_loss_sats) {
    throw new DailyLossCapError(
      `Daily loss cap reached: ${current} sats spent + ${additionalSats} projected = ${projected} >= ${policy.max_daily_loss_sats} sats limit. Automation halted.`
    );
  }
}
