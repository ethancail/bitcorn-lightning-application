// The Membership panel's rate across a failed poll (member-first-run-ui slice
// 4, R8): one failed 15 s read used to drop a good rate, so the dollars went
// and the no-price line came for 15 s. Now a failed read keeps the last good
// rate until it is genuinely stale, aged by the server's own thresholds
// (app/api/src/price/btcUsdCache.ts: fresh up to 10 minutes, stale after,
// none after 6 hours), the state the server would report for it.
//
// The panel's rate is the amount component's (amount/Amount.tsx):
//   undefined — loading (sats, no sentence);
//   null      — the read failed with no good rate to keep (the sentence);
//   a rate    — the server's, or the last good one, re-aged.

import type { ExchangeRate } from "../../api/client";

/** app/api/src/price/btcUsdCache.ts RATE_FRESH_MS and RATE_NONE_AFTER_MS. */
export const HELD_RATE_FRESH_MS = 10 * 60_000;
export const HELD_RATE_NONE_AFTER_MS = 6 * 3_600_000;

/** The rate to show after a failed read, given the one shown before it. */
export function holdRate(prev: ExchangeRate | null | undefined, nowMs: number): ExchangeRate | null {
  if (prev == null || prev.state === "none" || prev.usd == null || prev.fetched_at == null) return null;
  const age = nowMs - prev.fetched_at;
  if (age > HELD_RATE_NONE_AFTER_MS) return null;
  return { ...prev, age_ms: age, state: age > HELD_RATE_FRESH_MS ? "stale" : "fresh" };
}
