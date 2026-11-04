// The BTC/USD rate's state, as one line of text a page shows beside its dollar
// figures (drive-mode spec P1 item 3; R15(6)). Non-visual: it returns the
// words, the page places them. The state is the server's (/api/exchange-rate);
// this does not recompute ages.
//
//   fresh → null (dollars, nothing to say)
//   stale → "Price as of <time>" (dollars, dated)
//   none  → one sentence; the server sends usd: null, so the page shows sats
//
// "none" covers two cases: a rate older than 6 hours, and a node that has never
// fetched one (fetched_at: null, as on a fresh boot). The sentence claims no
// age, so it is true for both (drive-mode P2 item 8; pinned by rate.test.ts).

import type { ExchangeRate } from "./client";

export const RATE_NONE_SENTENCE =
  "The bitcoin price isn't available right now, so amounts are shown in sats.";

export function rateNote(rate: ExchangeRate | null | undefined): string | null {
  if (!rate) return null;
  if (rate.state === "stale" && rate.fetched_at != null) {
    const time = new Date(rate.fetched_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `Price as of ${time}`;
  }
  if (rate.state === "none") return RATE_NONE_SENTENCE;
  return null;
}
