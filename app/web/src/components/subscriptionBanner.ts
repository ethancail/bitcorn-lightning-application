// Pure descriptors for the ambient subscription surfaces: the dashboard
// banner (bannerFor) and the Settings nav badge (settingsBadgeFor).
//
// Source of truth:
//   - specs/2026-06-11-subscription-discoverability-implementation.md §3, §5
//   - specs/2026-05-12-subscription-panel-state-signal-system.md §2 (tier colors)
//
// This is the actionsFor(tier) mold (subscriptionActions.ts) applied to
// the banner + badge: keep the logic as data, not JSX, so the per-tier
// mapping is the unit-tested surface and the components stay thin
// renderers. Both descriptors share ONE tier→severity map (below) so the
// banner, badge, and the 402 RoutingDeniedNotice can't drift in color.
//
// Only the four payment-action tiers render. `current`, every
// applicable:false reason, and a null (not-yet-fetched) status all
// produce render:false / show:false — absence is the signal for a
// healthy member.

import { fmtSats, type SubscriptionStatus, type AutoPayConfig } from "../api/client";

export type GatedTier = "prepay" | "worker_lapsed" | "routing_lapsed" | "close_due";
export type BannerSeverity = "info" | "amber" | "orange" | "red";
export type BadgeSeverity = "blue" | "amber" | "orange" | "red";

// The single source of truth for tier→severity. The lapsed-tier rows are
// identical across banner and badge; prepay differs only in name (the
// banner's quiet "info" strip vs the badge's "blue" glyph), both the
// signal system's pre-activation register. Co-locating the rows is what
// prevents drift.
const SEVERITY_BY_TIER: Record<GatedTier, { banner: BannerSeverity; badge: BadgeSeverity }> = {
  prepay: { banner: "info", badge: "blue" },
  worker_lapsed: { banner: "amber", badge: "amber" },
  routing_lapsed: { banner: "orange", badge: "orange" },
  close_due: { banner: "red", badge: "red" },
};

/** Banner severity for a gated tier — imported by RoutingDeniedNotice so
 *  the point-of-block surface derives color from the same map. */
export function bannerSeverityForTier(tier: GatedTier): BannerSeverity {
  return SEVERITY_BY_TIER[tier].banner;
}

/** Same map as bannerSeverityForTier but tolerant of an arbitrary tier
 *  string (the 402 payload types tier as string). Returns null for any
 *  value outside the gated set. */
export function bannerSeverityForTierName(tier: string): BannerSeverity | null {
  return tier in SEVERITY_BY_TIER ? SEVERITY_BY_TIER[tier as GatedTier].banner : null;
}

// Presentation glue, shared by both the banner and the 402 notice so the
// two surfaces can't drift in CSS variant or icon. Banner severity →
// dashboard .alert variant class; → icon glyph (signal system §3: `i` for
// the quiet info strip, `⚠` for action-needed, `✕` reserved for red).
export const ALERT_VARIANT_CLASS: Record<BannerSeverity, string> = {
  info: "info",
  amber: "warning",
  orange: "orange",
  red: "critical",
};
export const SEVERITY_ICON: Record<BannerSeverity, string> = {
  info: "i",
  amber: "⚠",
  orange: "⚠",
  red: "✕",
};

/** Narrows a status to its gated tier, or null for healthy/unknown/
 *  not-applicable states. The single not-applicable + current + null
 *  filter both descriptors share. */
export function gatedTierOf(status: SubscriptionStatus | null): GatedTier | null {
  if (!status || status.applicable !== true) return null;
  const t = status.current_tier;
  if (t === "prepay" || t === "worker_lapsed" || t === "routing_lapsed" || t === "close_due") {
    return t;
  }
  return null; // current
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export interface BannerDescriptor {
  render: boolean;
  severity?: BannerSeverity;
  headline?: string;
  body?: string;
  actionLabel?: string;
}

/**
 * The dashboard banner descriptor. Takes the full status (so the
 * not-applicable / current / null filtering is inside the tested
 * function). Amounts always come from status.price_sats via fmtSats —
 * never a hardcoded 50,000.
 *
 * nowMs is retained in the signature (callers pass Date.now()) for
 * determinism of any future time-relative copy; no current branch reads
 * it. The close_due banner deliberately does NOT show a countdown:
 * `grace.close_at` is paid_through + grace_days_close, which is the
 * moment the close_due tier BEGINS — by the time the tier is close_due,
 * that instant is already in the past, and the Tier 3 scheduler closes
 * on its next tick (no further grace). A countdown would render a
 * non-positive number; the honest framing is "imminent / pay now".
 */
export function bannerFor(status: SubscriptionStatus | null, nowMs: number): BannerDescriptor {
  void nowMs;
  const tier = gatedTierOf(status);
  if (!tier || status?.applicable !== true) return { render: false };

  const price = fmtSats(status.price_sats);
  const lapsedOn = formatDate(status.paid_through);

  switch (tier) {
    case "prepay":
      return {
        render: true,
        severity: "info",
        headline: "Welcome to BitCorn — activate your membership",
        body: `Pay ${price} to unlock Lightning routing.`,
        actionLabel: `Pay ${price}`,
      };
    case "worker_lapsed":
      return {
        render: true,
        severity: "amber",
        headline: "Action needed: hosted services lapsed",
        body:
          `Your subscription lapsed on ${lapsedOn}. Hosted services are ` +
          `paused; your channel and routing still work. Renew ${price} to restore.`,
        actionLabel: `Renew ${price}`,
      };
    case "routing_lapsed":
      return {
        render: true,
        severity: "orange",
        headline: "Urgent: routing access blocked",
        body:
          `Your subscription lapsed on ${lapsedOn}. Payments through the hub ` +
          `are refused until you renew (${price}).`,
        actionLabel: `Renew ${price}`,
      };
    case "close_due":
      return {
        render: true,
        severity: "red",
        headline: "Critical: channel close imminent",
        body:
          `Your subscription lapsed on ${lapsedOn}. Your channel is now queued ` +
          `for cooperative close — paying ${price} now halts it.`,
        actionLabel: "Pay now to halt close",
      };
  }
}

// ─── Auto-pay surfaces (spec 2026-06-12 §6, §7B, §7C) ──────────────────────
//
// Kept here, alongside the tier banner/badge, so the auto-pay banner and nav
// badge derive from the same pure-descriptor discipline and can't drift. The
// MemberSubscriptionBanner composes these with bannerFor: the lapsed-tier
// banner takes visual priority; the price-change banner is independent and may
// stack; the per-alert banners are dismissible.

export interface PriceChangeBannerDescriptor {
  render: boolean;
  headline?: string;
  body?: string;
}

/** Non-dismissible price-change banner (§6). Renders only while the member is
 *  opted in and the live price differs from the last acknowledged one (the
 *  server computes price_change_pending; this turns it into copy). */
export function priceChangeBannerFor(cfg: AutoPayConfig | null): PriceChangeBannerDescriptor {
  if (!cfg || !cfg.price_change_pending || cfg.current_price == null) return { render: false };
  const prev =
    cfg.last_acknowledged_price != null ? fmtSats(cfg.last_acknowledged_price) : "a different amount";
  return {
    render: true,
    headline: "Subscription price has changed",
    body: `Your auto-pay will now charge ${fmtSats(cfg.current_price)}. Previously: ${prev}.`,
  };
}

/** Copy per auto-pay alert type (§5 table). Severity comes from the alert row;
 *  this is just the headline/body. */
export function autoPayAlertContent(type: string): { headline: string; body: string } {
  switch (type) {
    case "AUTOPAY_INSUFFICIENT_FUNDS":
      return {
        headline: "Auto-pay couldn't renew your subscription",
        body: "Your node's on-chain balance is below the renewal amount plus fee.",
      };
    case "AUTOPAY_LND_UNAVAILABLE":
      return {
        headline: "Auto-pay couldn't reach your node's wallet",
        body: "Auto-pay will retry automatically once your wallet is reachable.",
      };
    case "AUTOPAY_PAYMENT_FAILED":
      return {
        headline: "Auto-pay renewal failed to send",
        body: "The renewal payment couldn't be broadcast.",
      };
    case "AUTOPAY_FEE_ESTIMATE_FAILED":
      return {
        headline: "Auto-pay couldn't estimate the network fee",
        body: "Auto-pay will retry automatically.",
      };
    case "AUTOPAY_SUCCEEDED":
      return {
        headline: "Auto-pay renewed your subscription",
        body: "Your subscription was renewed automatically.",
      };
    default:
      return { headline: "Auto-pay update", body: "" };
  }
}

/** Nav-badge severity contributed by auto-pay state: amber for a pending price
 *  change or an active warning, blue for an info-only active alert, else null. */
export function autoPayBadgeSeverity(cfg: AutoPayConfig | null): BadgeSeverity | null {
  if (!cfg) return null;
  if (cfg.price_change_pending) return "amber";
  if (cfg.badge.highest_severity === "warning") return "amber";
  if (cfg.badge.highest_severity === "info") return "blue";
  return null;
}

const BADGE_RANK: Record<BadgeSeverity, number> = { blue: 1, amber: 2, orange: 3, red: 4 };

/** Combine the tier badge with the auto-pay badge severity, taking the higher
 *  severity (§7C — "highest-severity active signal"). */
export function combineBadges(
  tierBadge: BadgeDescriptor,
  apSeverity: BadgeSeverity | null,
): BadgeDescriptor {
  const tierSev = tierBadge.show ? tierBadge.severity ?? null : null;
  if (tierSev && apSeverity) {
    return { show: true, severity: BADGE_RANK[tierSev] >= BADGE_RANK[apSeverity] ? tierSev : apSeverity };
  }
  const sev = tierSev ?? apSeverity;
  return sev ? { show: true, severity: sev } : { show: false };
}

export interface BadgeDescriptor {
  show: boolean;
  severity?: BadgeSeverity;
}

/**
 * The Settings nav badge descriptor. Same input contract as bannerFor
 * (full status, not a pre-extracted tier) so the not-applicable filter
 * is tested once per descriptor.
 */
export function settingsBadgeFor(status: SubscriptionStatus | null): BadgeDescriptor {
  const tier = gatedTierOf(status);
  if (!tier) return { show: false };
  return { show: true, severity: SEVERITY_BY_TIER[tier].badge };
}
