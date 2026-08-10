// View-state derivation for the treasury's rail fee-revenue panel.
//
// Pure and dependency-light so all of it unit-tests without a DOM or a
// renderer — app/web/vitest.config.ts collects only `src/**/*.test.ts`, so
// logic left inside the .tsx is untestable in this project. Same pattern as
// subscriptionRevenueView.ts / freshness.ts / walletStatusView.ts.
//
// ─── WHY THIS IS NOT SubscriptionRevenuePanel's THREE STATES ──────────────
//
// That panel uses { loading | ok | error }, which is right for a figure the
// node computes from its own SQLite. This figure is different: it summarises
// data mirrored from another chain by a sync loop that can be behind, stuck, or
// never have run. So the number alone is not a fact — the number PLUS the
// cursor's freshness is.
//
// Concretely, zero is not one state. It is three:
//   - zero + fresh cursor        → a STATED zero. Nothing has settled. Say so.
//   - zero + stale cursor        → a DOUBTED zero. Newer settlements may exist
//                                  and simply not be indexed yet.
//   - zero + never_synced        → NOT A ZERO AT ALL. Nothing was ever looked
//                                  at, so rendering "$0.00" asserts something
//                                  the node does not know. Show no figure.
//
// Collapsing those is the specific failure this module exists to prevent, and
// it is not hypothetical for long: nothing has settled on the rail yet, so the
// treasury will sit on one of these three for days or weeks. A panel that
// renders them identically trains its reader to ignore it, and finishes doing
// so right as the number starts to matter.
//
// The rail already states this rule one layer down — see classifyRailStaleness
// in app/api/src/stablecoin/staleness.ts: "'Never synced' and 'synced, then
// went stale' are different facts and must render differently."

import type { RailFeeRevenueResponse } from "../api/client";

export type RailFeeView =
  | { kind: "loading" }
  /** Indexing has never run here. A STATUS, not a failure — render no figure. */
  | { kind: "never_synced" }
  /** Cursor fresh: the numbers are current and may be stated as fact. */
  | { kind: "ok"; data: RailFeeRevenueResponse }
  /** Last-known numbers of uncertain age — render them WITH a staleness marker. */
  | { kind: "stale"; data: RailFeeRevenueResponse }
  /** Never loaded at all. Distinct from never_synced: this one IS a failure. */
  | { kind: "error" };

/**
 * Map a fetch outcome to what the panel should show.
 *
 * @param data   This poll's response, or null if the poll failed.
 * @param prior  The last successful response, or null if there has never been
 *               one. Keeping it is the U24 rule (components/ErrorState.tsx): a
 *               failed poll must never collapse last-good data into an empty
 *               value that reads as "no revenue".
 */
export function deriveRailFeeView(
  data: RailFeeRevenueResponse | null,
  prior: RailFeeRevenueResponse | null,
): RailFeeView {
  // Poll failed. Last-good data if we have any (marked stale, since its age is
  // now unknown), otherwise a real error — never a fabricated zero.
  if (!data) {
    return prior ? { kind: "stale", data: prior } : { kind: "error" };
  }

  // A payload with NO freshness block cannot be trusted to state anything, so
  // it degrades to can't-tell rather than to a confident zero. Not theoretical:
  // the API and the web bundle ship as separate images, so a version skew — or
  // any future edit that drops the field — could produce exactly this. Found by
  // the negative control that removed `freshness`: before this guard the
  // destructure below threw a TypeError and took the panel down with it.
  // Fail-closed AND graceful; a crash is only half of the requirement.
  if (!data.freshness) return { kind: "never_synced" };

  // never_synced is checked FIRST and beats prior data, because it is not a
  // degree of staleness — it is the absence of any observation. `last_success_at
  // === 0` is the seeded sentinel (migration 044/053), not a 1970 timestamp;
  // treating it as one is what produced the "cursor age: 29,758,925 min" banner
  // this rail already fixed once (stablecoin/staleness.ts).
  const { staleness_label, last_success_at } = data.freshness;
  if (staleness_label === "never_synced" || last_success_at <= 0) {
    return { kind: "never_synced" };
  }

  if (staleness_label === "stale" || staleness_label === "very_stale") {
    return { kind: "stale", data };
  }

  return { kind: "ok", data };
}

/**
 * True when the panel may present a figure as a current fact. Exported so the
 * renderer cannot accidentally state a number under a doubted cursor — the
 * check is a named thing rather than an inline `kind === "ok"` that a later
 * edit could widen.
 */
export function isStatedFact(view: RailFeeView): boolean {
  return view.kind === "ok";
}
