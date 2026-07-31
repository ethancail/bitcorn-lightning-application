// Whether this member is entitled to the stablecoin rail, as data.
//
// Follows the subscriptionBanner.ts mold: the per-tier mapping is the
// unit-tested surface and the components stay thin renderers. Both rail-gating
// surfaces (the nav entry in App.tsx and the notice on the Stablecoin page) read
// from this ONE function so they cannot drift.
//
// ⚠ THIS IS NOT ENFORCEMENT. Enforcement is the Worker's `full`-scope gate on
// /base/{contract-state,balance,events} (cloudflare-worker/src/index.ts). This
// module decides only what the UI SAYS. A member who ignores it reaches the page
// anyway and simply finds no data, because the sync loop's Worker reads 403.
//
// The entitlement boundary is exactly the tier→scope boundary: `current` mints a
// full-scope token, every other tier mints payment-scope. So `gatedTierOf` —
// already the tested tier filter behind the dashboard banner and nav badge — is
// reused verbatim rather than re-deriving the same four-tier list here.
//
// FRESH GRACE RIDES ALONG, DELIBERATELY. A never-paid node inside its 30-day
// grace_days_fresh window (migration 042) has tier === "current", so
// gatedTierOf returns null and this module reports `entitled`. That is the
// decision recorded in the Worker's rationale block, not an accident of reusing
// gatedTierOf — trial members are meant to see the rail.

import type { SubscriptionStatus } from "../api/client";
import {
  bannerSeverityForTier,
  gatedTierOf,
  SEVERITY_ICON,
  type BannerSeverity,
  type GatedTier,
} from "../components/subscriptionBanner";

export type RailAccess =
  /** Tier `current` (paid, post-payment grace, or fresh grace) — full scope. */
  | { kind: "entitled" }
  /** A payment-scope tier. The Worker refuses this member's rail reads. */
  | { kind: "gated"; tier: GatedTier }
  /**
   * Status not yet fetched, or not applicable to this node (external peer, no
   * channel, no subscription row yet).
   *
   * FAILS OPEN ON PURPOSE. `useSubscriptionStatus` starts null and polls at 60s,
   * so gating on unknown would blink the rail out of the nav for up to a minute
   * on every load for perfectly healthy paying members. Since this module is
   * cosmetic and the Worker is the real gate, the safe direction here is to show
   * the surface and let the data (or the notice) speak. Matches the
   * "absence over noise" convention in subscriptionBanner.ts.
   */
  | { kind: "unknown" };

export function railAccessFor(status: SubscriptionStatus | null): RailAccess {
  if (!status || status.applicable !== true) return { kind: "unknown" };
  const tier = gatedTierOf(status);
  return tier ? { kind: "gated", tier } : { kind: "entitled" };
}

/** True only for a positively-known gated tier — the single condition both the
 *  nav filter and the page notice branch on. */
export function isRailGated(status: SubscriptionStatus | null): boolean {
  return railAccessFor(status).kind === "gated";
}

/**
 * BannerSeverity → the `.sub-alert-*` variant the stablecoin page's own banners
 * use. Deliberately a separate row set from ALERT_VARIANT_CLASS in
 * subscriptionBanner.ts: that maps to the DASHBOARD's `.alert` family, while
 * this page renders `sub-alert-*` (see StaleBanner / RailErrorBanner). Mapping
 * here keeps the notice visually of a piece with its neighbours while still
 * deriving its severity from the one shared tier map.
 *
 * `info` → dashed rather than a filled colour: prepay is the pre-activation
 * register (subscriptionBanner.ts SEVERITY_BY_TIER), where nothing is broken and
 * nothing has started. A filled amber would overstate it.
 */
export const RAIL_ALERT_CLASS: Record<BannerSeverity, string> = {
  info: "sub-alert-dashed",
  amber: "sub-alert-amber",
  orange: "sub-alert-orange",
  red: "sub-alert-red",
};

export interface RailGateNotice {
  render: boolean;
  severity?: BannerSeverity;
  /** Ready-to-use `.sub-alert-*` class, so the component stays a thin renderer. */
  variantClass?: string;
  icon?: string;
  headline?: string;
  body?: string;
}

/**
 * Copy for the "subscription required" notice on the Stablecoin page.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE STALENESS BANNER: before gating, a member
 * whose Worker reads were refused saw only the red "Settlement data is
 * significantly out of date" banner. With gating deliberately on, that message
 * is actively wrong — the data is not stale, the member is not entitled. These
 * two causes must never render as the same thing, so the page suppresses the
 * staleness banner whenever this notice renders.
 *
 * Severity comes from bannerSeverityForTier, the same map the dashboard banner
 * and the 402 RoutingDeniedNotice use, so the rail notice cannot drift in color
 * from the rest of the subscription surfaces.
 *
 * Deliberately says nothing about *balances being unavailable* as a loss of
 * funds: the rail is non-custodial. The honest framing is that Bitcorn's view
 * lapsed, not the member's money — so the copy points at what's actually gone
 * (history and balance display) and what isn't (the USDC itself).
 */
export function railGateNoticeFor(status: SubscriptionStatus | null): RailGateNotice {
  const access = railAccessFor(status);
  if (access.kind !== "gated") return { render: false };

  const severity = bannerSeverityForTier(access.tier);
  const common = {
    render: true as const,
    severity,
    variantClass: RAIL_ALERT_CLASS[severity],
    icon: SEVERITY_ICON[severity],
  };

  if (access.tier === "prepay") {
    // Never paid: nothing was ever running, so "paused" would be a lie.
    return {
      ...common,
      headline: "Stablecoin settlements need an active membership",
      body:
        "Activate your BitCorn membership to use USDC settlements. " +
        "Your USDC is untouched and still yours.",
    };
  }
  return {
    ...common,
    headline: "Stablecoin settlements are paused",
    body:
      "Your USDC is untouched and still yours — settlement history and balance " +
      "display are what pause. Renew to restore them.",
  };
}
