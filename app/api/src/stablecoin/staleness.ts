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

/**
 * 0 (and any non-positive value) is the never-synced sentinel, not a timestamp.
 * Migration 044 seeds base_sync_cursor at (0, 0) and migration 053 seeds both
 * new timestamps from it, so a node whose sync loop has never recorded a success
 * carries 0 here.
 *
 * Treating that as an epoch timestamp is what produced the "cursor age:
 * 29,758,925 min" banner — `now - 0` is ~56 years in milliseconds. It is a
 * finite number, so no NaN guard ever caught it.
 */
function isNeverSynced(asOfAtMs: number): boolean {
    return !Number.isFinite(asOfAtMs) || asOfAtMs <= 0;
}

export function railStalenessSeconds(asOfAtMs: number, nowMs: number): number {
    if (!Number.isFinite(asOfAtMs) || !Number.isFinite(nowMs)) return 0;
    // Never-synced has no meaningful age. Reporting ~1.78e9 seconds would put a
    // nonsense number on screen and in the banner's tooltip.
    if (isNeverSynced(asOfAtMs)) return 0;
    const elapsed = nowMs - asOfAtMs;
    if (elapsed < 0) return 0;
    return Math.floor(elapsed / 1000);
}

/**
 * Four-state classification. The three age buckets match the amendment's banner
 * thresholds; `never_synced` is a distinct state, not an extreme of the others:
 *   - "never_synced": no successful sync on record → NOT an error, no banner
 *   - "fresh":        < 3 min  → no banner
 *   - "stale":        3–15 min → subtle yellow banner
 *   - "very_stale":   ≥ 15 min → prominent red banner
 *
 * WHY never_synced IS SEPARATE. The most common state on release day is a
 * healthy node with no BASE wallet registered: sync.ts returns `no_wallets`
 * before it ever contacts the Worker, so the cursor stays at its seed and
 * nothing is wrong. Folding that into `very_stale` told every such subscriber
 * that their "settlement data is significantly out of date" — a red alarm about
 * a system working exactly as designed. "Never synced" and "synced, then went
 * stale" are different facts and must render differently.
 */
export function classifyRailStaleness(asOfAtMs: number, nowMs: number): RailStalenessLabel {
    if (isNeverSynced(asOfAtMs)) return "never_synced";
    const elapsed = Math.max(0, nowMs - asOfAtMs);
    if (elapsed >= RAIL_VERY_STALE_THRESHOLD_MS) return "very_stale";
    if (elapsed >= RAIL_STALE_THRESHOLD_MS) return "stale";
    return "fresh";
}
