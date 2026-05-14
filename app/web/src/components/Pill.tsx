// Shared pill component — implements the signal system §2 color
// vocabulary. Source of truth:
//   bitcorn-research/specs/2026-05-12-subscription-panel-state-signal-system.md §2
//
// Originally lived inline in SubscriptionPanel.tsx; extracted in Stage 5b
// (admin members list) per the spec's T3 verification gate. Two surfaces
// consume it now: the subscription panel (uses tierToPill — 5 states) and
// the admin members list (uses stateToPill — 11 states including non-row
// reasons). Future surfaces needing pill rendering inherit either helper.
//
// The signal system's rule: "consume the vocabulary, don't extend it
// locally." Add new states by adding cases to the helpers below, not by
// inventing new pill kinds.

import type { SubscriptionTier } from "../api/client";

/**
 * Signal-system §2 pill colors. Eight values: each one encodes a
 * distinct emotional register / semantic meaning. The "no pill" mode
 * is represented by *not* rendering a Pill component at all (e.g.,
 * the subscription panel's external_peer state).
 */
export type PillKind =
  | "emerald"       // healthy / current
  | "blue"          // prepay / stable-but-limited
  | "gray-pulsing"  // transient system state
  | "muted-amber"   // non-blocking advisory
  | "amber"         // first friction tier
  | "orange"        // escalated friction
  | "red"           // urgent action
  | "dim-red";      // honest error / data anomaly

export function Pill({ kind, label }: { kind: PillKind; label: string }) {
  return (
    <span className={`sub-pill sub-pill-${kind}`}>
      <span className="sub-pill-dot" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Subscription-panel helper — maps the 5 tier values to {kind, label}
 * pairs with member-facing copy (e.g., "services paused" rather than
 * the raw "worker_lapsed" identifier). The panel's pill is one of the
 * panel's primary signals; its copy is content, not metadata.
 */
export function tierToPill(tier: SubscriptionTier): { kind: PillKind; label: string } {
  switch (tier) {
    case "current":         return { kind: "emerald", label: "current" };
    case "prepay":          return { kind: "blue", label: "prepay" };
    case "worker_lapsed":   return { kind: "amber", label: "services paused" };
    case "routing_lapsed":  return { kind: "orange", label: "routing paused" };
    case "close_due":       return { kind: "red", label: "pay to halt close" };
  }
}

/**
 * Admin-members helper — maps the 11-state vocabulary (5 tier values +
 * 5 non-row reasons + the "no_channel" placeholder) to {kind, label}.
 * Used by the admin distribution counter and the per-row state cell.
 *
 * Labels are the underscore-form state identifier (e.g., "worker_lapsed")
 * rather than the panel's member-facing copy ("services paused"). This
 * is intentional: the admin view is operator-facing technical surface
 * where matching the spec/code state identifier exactly is more useful
 * than translated copy. The panel's member-facing translation lives in
 * tierToPill above.
 */
export type SubscriptionStateKey =
  | "current"
  | "prepay"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due"
  | "external_peer"
  | "unclassified"
  | "not_yet_allocated"
  | "missing"
  | "no_channel";

export function stateToPill(state: SubscriptionStateKey): { kind: PillKind; label: string } {
  switch (state) {
    case "current":            return { kind: "emerald", label: "current" };
    case "prepay":             return { kind: "blue", label: "prepay" };
    case "worker_lapsed":      return { kind: "amber", label: "worker_lapsed" };
    case "routing_lapsed":     return { kind: "orange", label: "routing_lapsed" };
    case "close_due":          return { kind: "red", label: "close_due" };
    case "not_yet_allocated":  return { kind: "gray-pulsing", label: "not_yet_allocated" };
    case "unclassified":       return { kind: "muted-amber", label: "unclassified" };
    case "external_peer":      return { kind: "muted-amber", label: "external_peer" };
    case "no_channel":         return { kind: "muted-amber", label: "no_channel" };
    case "missing":            return { kind: "dim-red", label: "missing" };
  }
}
