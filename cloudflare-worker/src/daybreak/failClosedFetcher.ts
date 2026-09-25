// The close fetcher Radar's write route runs intake with UNTIL THE YAHOO ADAPTER
// EXISTS (spec §3.4.4, Ruling 2).
//
// It never fetches. Every call is an explicit failure with no value, so intake
// writes the draft with its sections intact and the Z unavailable (I.2):
// `fetch_failed` when the power-law parameters are seeded, `params_unavailable`
// when they are not — intake checks the parameters BEFORE it fetches.
//
// ⚠ THE YAHOO ADAPTER REPLACES THIS, at its one use in handlers/daybreakDraft.ts.
// It is not a fallback to keep beside that adapter: an adapter that fails must
// fail on its own terms (closes.ts, "THE CONTRACT AN ADAPTER MUST KEEP").

import type { CloseFetcher } from "./closes";

export const FAIL_CLOSED_FETCHER: CloseFetcher = {
  async latestCompletedClose(symbol) {
    return {
      ok: false,
      symbol,
      reason: "no_adapter",
      detail: "no close adapter is configured yet; the Yahoo adapter replaces this fail-closed fetcher",
    };
  },
};
