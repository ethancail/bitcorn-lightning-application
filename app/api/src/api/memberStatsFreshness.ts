// Provenance for the member dashboard's channel numbers.
//
// ─── THE DEFECT THIS FIXES ──────────────────────────────────────────────────
//
// During the 2026-08-17 cert expiry, a farmer's dashboard showed a channel
// balance while every live Lightning read was failing, and read it as their
// money being gone. Tracing it:
//
//   /api/node/balances     -> 500. Its live getLndChainBalance() is the FIRST
//                            statement in a single try, so it fails closed and
//                            the web freshness tracker eventually marks it.
//   /api/member/stats      -> 200, with FROZEN channel balances. Its two live
//                            LND calls are each wrapped in `catch {}` marked
//                            "non-fatal", and treasury_channel comes from a
//                            plain SELECT over lnd_channels. So the poll
//                            SUCCEEDS and the number renders with no marker.
//
// The rows freeze because lightning/sync.ts:35 throws before reaching
// persistChannels() at :41, so nothing updates lnd_channels — and because
// `active` is never rewritten either, `is_active` keeps reporting true.
//
// ─── WHY NOT app/web/src/components/freshness.ts ────────────────────────────
//
// That primitive is POLL-OUTCOME driven: it counts consecutive failed fetches.
// This endpoint returns 200, so its poll never fails and wiring it in would
// change NOTHING. The staleness here has to be DATA-AGE driven.
//
// ─── SO THIS REUSES ../base/staleness.ts ────────────────────────────────────
//
// Already pure, already clock-injected, already data-age driven
// (stalenessSecondsForBalance / classifyStaleness), and written for exactly this
// shape of question on the BASE rail. No new primitive.
//
// UNITS, VERIFIED RATHER THAN ASSUMED: base/staleness.ts expects unix-MS, and
// lightning/persist-channels.ts:37 writes `Date.now()` into
// lnd_channels.updated_at. Both milliseconds, no conversion. (The same endpoint
// uses SECONDS for its forwarded-fee cutoffs, which is why this was worth
// checking rather than eyeballing.)
//
// Thresholds come from base/staleness.ts: 5 min -> stale, 30 min -> very_stale.
// Against a 15s sync loop that is 20 missed cycles before anything is said,
// which is the same don't-alarm-on-one-tick discipline as freshness.ts's
// 3-strike threshold.

import {
  classifyStaleness,
  stalenessSecondsForBalance,
  type StalenessLabel,
} from "../base/staleness";

export interface ChannelDataFreshness {
  /** Unix ms from lnd_channels.updated_at, or null if never synced. */
  updated_at_ms: number | null;
  /** Seconds since that write, or null if never synced. */
  age_seconds: number | null;
  /**
   * "never_synced" is deliberately DISTINCT from "very_stale": a row that has
   * never been written is not an old row, and collapsing them would let a
   * fresh install look like a broken one. Same reasoning as
   * components/railFeeRevenueView.ts's `never_synced` case.
   */
  staleness: StalenessLabel | "never_synced";
}

/**
 * Pure. Describe how old a channel row is. `nowMs` injected by the caller.
 */
export function channelDataFreshness(
  updatedAtMs: number | null | undefined,
  nowMs: number,
): ChannelDataFreshness {
  if (updatedAtMs == null || !Number.isFinite(updatedAtMs)) {
    return { updated_at_ms: null, age_seconds: null, staleness: "never_synced" };
  }
  return {
    updated_at_ms: updatedAtMs,
    age_seconds: stalenessSecondsForBalance(updatedAtMs, nowMs),
    staleness: classifyStaleness(updatedAtMs, nowMs),
  };
}
