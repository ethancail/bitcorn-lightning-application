// Per-state action descriptor for the subscription panel's ACTIONS row.
//
// Source of truth:
//   - decisions/2026-06-11-subscription-panel-action-button-behaviors.md
//   - specs/2026-05-12-subscription-panel-state-signal-system.md §4
//     (Onramp-primary pattern + label discipline)
//
// This is the single description the four Onramp-primary renders build
// their buttons from. Keeping it data (not JSX) is what lets the
// per-state test assert that BOTH action buttons carry a handler-bearing
// kind in every Onramp-primary state — the bug that shipped was buttons
// rendering with no onClick, which a descriptor like this makes
// impossible to reproduce silently.

import { fmtSats } from "../api/client";
import type { SubscriptionTier } from "../api/client";

/** What a button DOES. Every kind except "none" maps to a real handler
 *  in the panel; the test asserts the Onramp-primary states never carry
 *  "none" in their primary/secondary slots. */
export type ActionKind = "onramp" | "pay-modal" | "refresh" | "history" | "renew";

export interface ActionDescriptor {
  kind: ActionKind;
  /** Text label, WITHOUT the trailing decorative arrow. */
  label: string;
  /** Optional decorative arrow rendered aria-hidden by the panel. */
  glyph?: "↗" | "→";
}

export interface PanelActions {
  primary?: ActionDescriptor;
  secondary?: ActionDescriptor;
  tertiary?: ActionDescriptor;
}

/** The four states using the locked Onramp-primary pattern. */
export const ONRAMP_PRIMARY_TIERS: SubscriptionTier[] = [
  "prepay",
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
];

export function isOnrampPrimary(tier: SubscriptionTier): boolean {
  return ONRAMP_PRIMARY_TIERS.includes(tier);
}

const ONRAMP_PRIMARY: ActionDescriptor = {
  kind: "onramp",
  label: "Open Coinbase Onramp",
  glyph: "↗",
};

const HISTORY_TERTIARY: ActionDescriptor = {
  kind: "history",
  label: "View payment history",
  glyph: "→",
};

/** Secondary "I have BTC — …" label per state. Verb and amount-framing
 *  match the locked copy: prepay pays, the lapsed family renews, and
 *  close_due halts the pending close. */
function payModalSecondary(tier: SubscriptionTier, priceSats: number): ActionDescriptor {
  switch (tier) {
    case "prepay":
      return { kind: "pay-modal", label: `I have BTC — pay ${fmtSats(priceSats)}` };
    case "worker_lapsed":
    case "routing_lapsed":
      return { kind: "pay-modal", label: `I have BTC — renew (${fmtSats(priceSats)})` };
    case "close_due":
      return { kind: "pay-modal", label: "I have BTC — pay now to halt close" };
    default:
      return { kind: "pay-modal", label: `I have BTC — pay ${fmtSats(priceSats)}` };
  }
}

/**
 * Returns the ACTIONS-row descriptor for a given tier. The four
 * Onramp-primary states get Onramp primary + pay-modal secondary; the
 * lapsed family and close_due also get the history tertiary. `current`
 * keeps its own (renew / refresh / history) shape — included for
 * completeness, though the panel renders `current` separately.
 */
export function actionsFor(tier: SubscriptionTier, priceSats: number): PanelActions {
  if (isOnrampPrimary(tier)) {
    return {
      primary: ONRAMP_PRIMARY,
      secondary: payModalSecondary(tier, priceSats),
      // prepay shows no tertiary; the lapsed family + close_due do.
      tertiary: tier === "prepay" ? undefined : HISTORY_TERTIARY,
    };
  }
  // current (not an Onramp-primary state)
  return {
    primary: { kind: "renew", label: "Renew now", glyph: "→" },
    secondary: { kind: "refresh", label: "Refresh token" },
    tertiary: HISTORY_TERTIARY,
  };
}
