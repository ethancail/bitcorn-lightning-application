// StaleBanner — three threshold variants per spec amendment §7.
//
// Under 3 min cursor age:   no banner at all (returns null)
// 3–15 min cursor age:      subtle yellow banner — "Some data may be a
//                           few minutes old. Bitcorn is reconnecting."
// Over 15 min cursor age:   prominent red banner — "Settlement data is
//                           significantly out of date…"
//
// The block-number signal appears as a hover-tooltip annotation on
// the banner for power users (spec §7: "appears in a hover tooltip on
// the staleness banner"). Wall-clock drives the threshold itself.
//
// The threshold logic mirrors app/api/src/stablecoin/staleness.ts —
// the API surfaces `staleness_label: "fresh" | "stale" | "very_stale"`
// already classified. This component renders against that label rather
// than re-classifying client-side, so any future threshold tuning
// happens in a single place.

import type { SyncCursorResponse } from "../client";

export default function StaleBanner({
  cursor,
}: {
  cursor: SyncCursorResponse | null;
}) {
  if (!cursor) return null;
  if (cursor.staleness_label === "fresh") return null;

  const ageMin = Math.floor(cursor.staleness_seconds / 60);
  const tooltip = `Last synced block: ${cursor.last_synced_block_number.toLocaleString()}. Cursor age: ${cursor.staleness_seconds}s.`;

  if (cursor.staleness_label === "stale") {
    return (
      <div className="sub-alert sub-alert-amber stablecoin-banner" title={tooltip}>
        <span className="sub-alert-icon" aria-hidden>⚠</span>
        <div className="sub-alert-body">
          Some data may be a few minutes old. Bitcorn is reconnecting.
          <span className="sub-error-detail"> (cursor age: {ageMin} min)</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sub-alert sub-alert-red stablecoin-banner" title={tooltip}>
      <span className="sub-alert-icon" aria-hidden>✕</span>
      <div className="sub-alert-body">
        <strong>Settlement data is significantly out of date.</strong> Sending settlements still
        works (your wallet talks directly to BASE) but the activity shown may not reflect the
        latest on-chain state.
        <span className="sub-error-detail"> (cursor age: {ageMin} min)</span>
      </div>
    </div>
  );
}
