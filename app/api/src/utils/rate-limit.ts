import { db } from "../db";
import { ENV } from "../config/env";

const MAX_TX_PER_MINUTE = ENV.rateLimitTxPerMinute ?? 5;
const MAX_SATS_PER_MINUTE = ENV.rateLimitSatsPerMinute ?? 100_000;
const MAX_SATS_PER_HOUR = ENV.rateLimitSatsPerHour ?? 1_000_000;
const MAX_SINGLE_PAYMENT = ENV.rateLimitMaxSinglePayment ?? 250_000;

/**
 * Asserts that the payment does not exceed rate limits
 * @param tokens - The amount of tokens (sats) for this payment
 * @throws Error if any rate limit is exceeded
 */
export function assertRateLimit(tokens: number): void {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const oneHourAgo = now - 3600 * 1000;

  // Check max single payment
  if (tokens > MAX_SINGLE_PAYMENT) {
    throw new Error(`Rate limit exceeded: payment amount ${tokens} exceeds maximum ${MAX_SINGLE_PAYMENT} sats`);
  }

  // Count all payment attempts in last minute (prevents brute force)
  const txCountLastMinute = db
    .prepare(`
      SELECT COUNT(*) as count
      FROM payments_outbound
      WHERE created_at > ?
    `)
    .get(oneMinuteAgo) as { count: number };

  if (txCountLastMinute.count >= MAX_TX_PER_MINUTE) {
    throw new Error(`Rate limit exceeded: ${txCountLastMinute.count} payments in last minute (max: ${MAX_TX_PER_MINUTE})`);
  }

  // Sum all payment attempts in last minute (prevents spam)
  const satsLastMinute = db
    .prepare(`
      SELECT COALESCE(SUM(tokens), 0) as total
      FROM payments_outbound
      WHERE created_at > ?
    `)
    .get(oneMinuteAgo) as { total: number };

  const totalSatsThisMinute = (satsLastMinute.total ?? 0) + tokens;
  if (totalSatsThisMinute > MAX_SATS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded: ${totalSatsThisMinute} sats in last minute (max: ${MAX_SATS_PER_MINUTE})`);
  }

  // Sum only succeeded payments in last hour (protects liquidity)
  const satsLastHour = db
    .prepare(`
      SELECT COALESCE(SUM(tokens), 0) as total
      FROM payments_outbound
      WHERE created_at > ? AND status = 'succeeded'
    `)
    .get(oneHourAgo) as { total: number };

  const totalSatsThisHour = (satsLastHour.total ?? 0) + tokens;
  if (totalSatsThisHour > MAX_SATS_PER_HOUR) {
    throw new Error(`Rate limit exceeded: ${totalSatsThisHour} sats in last hour (max: ${MAX_SATS_PER_HOUR})`);
  }
}
