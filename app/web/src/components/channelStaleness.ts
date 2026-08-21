// Copy for "these channel numbers may be old", derived not inlined.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// During the 2026-08-17 cert expiry the member dashboard rendered a channel
// balance while every live Lightning read was failing, and the farmer read it
// as their money being gone. The numbers came from SQLite via
// /api/member/stats, which answers 200 even when LND is unreachable (its two
// live reads were swallowed as "non-fatal"), so nothing on the page said the
// figures were frozen.
//
// ⚠ ./freshness.ts CANNOT COVER THIS. It is POLL-OUTCOME driven — it counts
// consecutive failed fetches — and this endpoint's poll SUCCEEDS. Wiring the
// stats poll into it would change nothing. The staleness has to come from the
// DATA'S AGE, which the API now supplies (lnd_channels.updated_at, classified
// with the API's base/staleness.ts thresholds).
//
// Pure + clock-injected, like ./freshness.ts and ./subscriptionBanner.ts, so
// the copy is unit-testable rather than asserted about by reading JSX.
//
// ⚠ COPY CONSTRAINT: nothing here may say "ask your node operator" or "contact
// your operator". On a member node the farmer IS the node operator, so that
// phrasing routes them back to themselves. Same rule as
// ./actionConfirm/confirmAction.ts:96, pinned by a test in the same shape as
// ./actionConfirm/confirmMachine.test.ts:153-154.
//
// ⚠ AND IT MUST READ CORRECTLY TO SOMEONE WHOSE NODE IS FINE. This ships as a
// release and members update by clicking, so it lands on a large majority of
// healthy nodes. For them this returns null and the dashboard is pixel-identical
// to before.

import { ageLabel } from "./freshness";

export type ChannelStaleness = "fresh" | "stale" | "very_stale" | "never_synced";

export interface ChannelFreshnessInput {
  updated_at_ms: number | null;
  age_seconds: number | null;
  staleness: ChannelStaleness;
}

export interface StalenessNotice {
  severity: "warning" | "critical";
  text: string;
}

/**
 * Pure. Decide whether to say anything about the age of the channel numbers.
 *
 * Returns null when there is nothing to say — a synced node with a reachable
 * LND. `nowMs` is injected by the caller.
 */
export function channelStalenessNotice(
  freshness: ChannelFreshnessInput | null | undefined,
  lndLiveReadOk: boolean,
  nowMs: number,
): StalenessNotice | null {
  if (!freshness) return null;

  const { staleness, updated_at_ms } = freshness;

  // Never written: a fresh install, not a broken node. Kept distinct from
  // very_stale so the two do not read the same.
  if (staleness === "never_synced") {
    return {
      severity: "warning",
      text:
        "These figures haven't synced from your node yet. " +
        "They'll fill in once your node finishes starting up.",
    };
  }

  const aged = staleness === "stale" || staleness === "very_stale";
  if (!aged && lndLiveReadOk) return null;

  const when = updated_at_ms != null ? ageLabel(updated_at_ms, nowMs) : "an unknown time ago";

  // Both signals present: the numbers are old AND we know why.
  if (aged && !lndLiveReadOk) {
    return {
      severity: staleness === "very_stale" ? "critical" : "warning",
      text:
        `Last updated ${when}. Your node's Lightning service isn't responding, ` +
        `so these figures are the last ones recorded — not current. ` +
        `Your channel and funds are unaffected by this display problem. ` +
        `Restarting the Lightning app, then Bitcorn, usually restores it.`,
    };
  }

  // Old, but the live reads are working — a sync loop that is behind.
  if (aged) {
    return {
      severity: staleness === "very_stale" ? "critical" : "warning",
      text:
        `Last updated ${when}, so these figures may not be current. ` +
        `Your channel and funds are unaffected by this display problem.`,
    };
  }

  // Fresh numbers, but a live read failed this poll — worth a quiet note only.
  return {
    severity: "warning",
    text:
      `Your node's Lightning service didn't respond just now. These figures are ` +
      `from ${when} and may stop updating. Your channel and funds are unaffected.`,
  };
}
