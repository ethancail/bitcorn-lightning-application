// Pure poll-freshness tracker — Tier C of the U24 "outage ≠ empty" reference
// pattern: keep last-good data + a staleness marker, never clear to "—"/empty
// on a poll failure.
//
// A polling surface records each poll result; the derived status is:
//   fresh       — under the failure threshold; render data normally
//   stale       — threshold hit but last-good data exists; KEEP showing it,
//                 with a StaleMarker (./StaleMarker.tsx) alongside
//   unavailable — threshold hit and no data ever loaded; show a small error
//                 affordance instead of an ambiguous placeholder
//
// The threshold (default 3 consecutive failures) exists so a single blip on a
// 15–60s poll doesn't flash a warning — the same don't-alarm-on-one-tick
// discipline as the stablecoin rail's staleness gradient. Kept as pure
// functions (not a hook) per the project pattern (payModalMachine.ts,
// subscriptionBanner.ts) so the threshold logic is unit-testable.
//
// First consumers (U24 Batch A): MemberDashboard balance poll (H8) and the
// Withdraw/Refill tracking polls (H5).

export interface FreshnessState {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
}

export const INITIAL_FRESHNESS: FreshnessState = {
  consecutiveFailures: 0,
  lastSuccessAt: null,
};

export const DEFAULT_STALE_THRESHOLD = 3;

export function recordSuccess(_prev: FreshnessState, nowMs: number): FreshnessState {
  return { consecutiveFailures: 0, lastSuccessAt: nowMs };
}

export function recordFailure(prev: FreshnessState): FreshnessState {
  return { ...prev, consecutiveFailures: prev.consecutiveFailures + 1 };
}

export type FreshnessStatus = "fresh" | "stale" | "unavailable";

export function freshnessStatus(
  state: FreshnessState,
  hasData: boolean,
  threshold: number = DEFAULT_STALE_THRESHOLD,
): FreshnessStatus {
  if (state.consecutiveFailures < threshold) return "fresh";
  return hasData ? "stale" : "unavailable";
}

/** "45s ago" / "3m ago" / "2h ago" — for "last updated …" copy. */
export function ageLabel(lastSuccessAt: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - lastSuccessAt) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}
