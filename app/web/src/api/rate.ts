// The BTC/USD rate's state, as one line of text a page shows beside its dollar
// figures (drive-mode spec P1 item 3; R15(6)). Non-visual: it returns the
// words, the page places them. The state is the server's (/api/exchange-rate);
// this does not recompute ages.
//
//   fresh → null (dollars, nothing to say)
//   stale → "Price as of <time>" (dollars, dated)
//   none  → one sentence; the server sends usd: null, so the page shows sats

import type { ExchangeRate } from "./client";

export const RATE_NONE_SENTENCE =
  "The bitcoin price hasn't updated in over 6 hours, so amounts are shown in sats only.";

export function rateNote(rate: ExchangeRate | null | undefined): string | null {
  if (!rate) return null;
  if (rate.state === "stale" && rate.fetched_at != null) {
    const time = new Date(rate.fetched_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `Price as of ${time}`;
  }
  if (rate.state === "none") return RATE_NONE_SENTENCE;
  return null;
}
