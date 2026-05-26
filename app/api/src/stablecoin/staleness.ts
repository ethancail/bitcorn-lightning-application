// Rail-specific staleness thresholds for the §7 banner.
//
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §7
//
// Distinct from base/staleness.ts:
//   - base/staleness.ts thresholds: 5min / 30min (generic §5.4 staleness)
//   - rail/staleness thresholds: 3min / 15min (locked by amendment §7)
//
// The amendment chose tighter thresholds for the rail because the
// settlement-history surface is more time-sensitive than the generic
// "data is X minutes old" cache rendering — users initiating
// settlements need to know quickly when the surface is degraded.
//
// Pure functions; no DB / no clock dependency. Same shape as the
// base/staleness.ts module (intentional, mirrors the convention).

import type { RailStalenessLabel } from "./types";

/** Below this age, the banner is hidden (UI shows nothing). */
export const RAIL_STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

/** At or above this age, the prominent "significantly out of date" banner shows. */
export const RAIL_VERY_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export function railStalenessSeconds(asOfAtMs: number, nowMs: number): number {
    if (!Number.isFinite(asOfAtMs) || !Number.isFinite(nowMs)) return 0;
    const elapsed = nowMs - asOfAtMs;
    if (elapsed < 0) return 0;
    return Math.floor(elapsed / 1000);
}

/**
 * Three-bucket classification matching the amendment's banner thresholds:
 *   - "fresh":      < 3 min  → no banner
 *   - "stale":      3–15 min → subtle yellow banner
 *   - "very_stale": ≥ 15 min → prominent red banner
 */
export function classifyRailStaleness(asOfAtMs: number, nowMs: number): RailStalenessLabel {
    const elapsed = Math.max(0, nowMs - asOfAtMs);
    if (elapsed >= RAIL_VERY_STALE_THRESHOLD_MS) return "very_stale";
    if (elapsed >= RAIL_STALE_THRESHOLD_MS) return "stale";
    return "fresh";
}
