// Inline amber staleness marker — the display half of ./freshness.ts (Tier C
// of the U24 reference pattern). Rendered NEXT TO last-good data when a poll
// has failed repeatedly; the data stays on screen, this says it may be old.
//
// Inline styles on the app's CSS variables (matching the app's inline-note
// convention) — deliberately no new design-system class. Companion to
// ./ErrorState.tsx: ErrorState is for "nothing to show"; StaleMarker is for
// "showing last-good data of uncertain age."

import { ageLabel, type FreshnessState } from "./freshness";

export default function StaleMarker({
  state,
  nowMs,
  noun = "Data",
}: {
  state: FreshnessState;
  nowMs: number;
  noun?: string;
}) {
  return (
    <span
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "0.75rem",
        color: "var(--amber)",
        fontFamily: "var(--mono)",
      }}
    >
      <span aria-hidden>⚠</span>
      <span>
        {noun} may be out of date
        {state.lastSuccessAt != null && <> — last updated {ageLabel(state.lastSuccessAt, nowMs)}</>}
      </span>
    </span>
  );
}
