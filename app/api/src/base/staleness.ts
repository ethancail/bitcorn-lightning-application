// Pure functions for deriving stale-data signals from sync-loop timestamps.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §5.4
//
// Used by the §8 member-facing API endpoints that surface cached BASE
// state to the UI. The sync loop populates as_of_at on every successful
// upsert; these helpers translate the elapsed time since that anchor
// into a user-meaningful staleness signal.
//
// Pure (no DB / no clock dependency) so they're trivially testable.
// `now` is always passed in by the caller — production callers pass
// `Date.now()`; tests pass a fixed timestamp.

export type StalenessLabel = "fresh" | "stale" | "very_stale";

/** Threshold (ms) above which a cached balance is considered "stale". */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Threshold (ms) above which the UI should surface a banner per spec §5.4. */
export const VERY_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Compute how many seconds have elapsed since `asOfAt` (a unix-ms timestamp
 * written by the sync loop). Returns 0 if `now` is at or before `asOfAt`
 * (clock skew edge case).
 */
export function stalenessSecondsForBalance(asOfAtMs: number, nowMs: number): number {
    if (!Number.isFinite(asOfAtMs) || !Number.isFinite(nowMs)) return 0;
    const elapsedMs = nowMs - asOfAtMs;
    if (elapsedMs < 0) return 0;
    return Math.floor(elapsedMs / 1000);
}

/**
 * Boolean predicate: "is this cached value stale enough to mark in the UI?"
 * The default 5-minute threshold matches §5.4's "data is X minutes old"
 * language; UI uses this to dim or annotate the cached number.
 */
export function isStaleByThreshold(
    asOfAtMs: number,
    nowMs: number,
    thresholdMs: number = STALE_THRESHOLD_MS,
): boolean {
    return stalenessSecondsForBalance(asOfAtMs, nowMs) * 1000 >= thresholdMs;
}

/**
 * Three-bucket classification used by the UI to pick rendering treatment:
 *   - "fresh":      < 5 minutes old; render normally
 *   - "stale":      5-30 minutes old; render with a subtle "as of X min ago" hint
 *   - "very_stale": ≥ 30 minutes old; render with the banner per §5.4
 */
export function classifyStaleness(asOfAtMs: number, nowMs: number): StalenessLabel {
    const elapsedMs = Math.max(0, nowMs - asOfAtMs);
    if (elapsedMs >= VERY_STALE_THRESHOLD_MS) return "very_stale";
    if (elapsedMs >= STALE_THRESHOLD_MS) return "stale";
    return "fresh";
}
