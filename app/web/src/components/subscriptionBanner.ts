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
import { trustCopy, trustStateOfRefusal } from "./paymentTrust";

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
  // L2: routing_lapsed's severity, not red. Tier 3 issues no close, so nothing
  // escalates at close_due; Stage 6 restores red only once a close is real.
  close_due: { banner: "orange", badge: "orange" },
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
  /** The body without its sentence asking for payment, for a status this node
   *  won't pay (G3 finding 2, ruled 2026-11-11). Absent when the body is only
   *  that sentence. */
  context?: string;
  actionLabel?: string;
}

/** An amount for the renewal copy: dollars with the sats beside them, or the
 *  sats alone with no rate (drive-mode P2 items 11-12). Also the pay-from-node
 *  modal's amounts (dollars first, R2). */
export function renewalAmount(sats: number, usdRate: number | null): { text: string; label: string } {
  if (!usdRate) return { text: fmtSats(sats), label: fmtSats(sats) };
  const usd = `$${((sats / 100_000_000) * usdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { text: `${usd} (${fmtSats(sats)})`, label: usd };
}

/**
 * The dashboard banner descriptor. Takes the full status (so the
 * not-applicable / current / null filtering is inside the tested
 * function). Amounts always come from status.price_sats via fmtSats —
 * never a hard-coded price.
 *
 * nowMs places the pre-pause warning (drive-mode P2 item 11): from P
 * (paid_through) until grace.worker_until the tier is still "current", and
 * the banner says when hosted services pause. Both dates are the status's
 * own, never a literal 7 days. usdRate, when there is one, puts dollars
 * first in that warning and in the services-paused banner (item 12).
 * No banner shows a close countdown: Tier 3 issues no close (L2), so
 * close_due carries routing_lapsed's copy.
 */
export function bannerFor(
  status: SubscriptionStatus | null,
  nowMs: number,
  usdRate: number | null = null,
): BannerDescriptor {
  // Item 11 (R6(a), D2.4): the warning before services pause. Starts at P
  // (R27(11)); past worker_until the server's tier is worker_lapsed.
  if (
    status?.applicable === true &&
    status.current_tier === "current" &&
    nowMs >= status.paid_through &&
    nowMs < status.grace.worker_until
  ) {
    const amount = renewalAmount(status.price_sats, usdRate);
    return {
      render: true,
      severity: "amber",
      // A headline, so no full stop, like the others (R34 item 6).
      headline: `Hosted services pause on ${formatDate(status.grace.worker_until)}`,
      body: `Renew for ${amount.text} before then to keep them running.`,
      actionLabel: `Renew ${amount.label}`,
    };
  }

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
    case "worker_lapsed": {
      // Item 12: the dollar amount, with the sats beside it.
      const amount = renewalAmount(status.price_sats, usdRate);
      const context =
        `Your subscription lapsed on ${lapsedOn}. Hosted services are ` +
        `paused; your channel and routing still work.`;
      return {
        render: true,
        severity: "amber",
        headline: "Action needed: hosted services lapsed",
        body: `${context} Renew for ${amount.text} to restore.`,
        context,
        actionLabel: `Renew ${amount.label}`,
      };
    }
    case "routing_lapsed":
      // Membership-gating M2 item 3 (R3; pass 10 item 1, split into headline
      // and body by Ethan's Phase 2 ruling). What actually stops at + 30 is the
      // hosted services; the old copy ("routing access blocked", "payments
      // through the hub are refused") claimed a routing loss that does not
      // happen. The banner file's long-term owner is still open (spec §8).
    case "close_due": {
      // L2: close_due's copy matches routing_lapsed's because Tier 3 issues no
      // close (tier3Scheduler.ts is dry-run only and returns would_close). Stage 6
      // restores close copy only once a close is real. The severity is the same too.
      // The body's amount is dollars first with the sats, or sats alone with no
      // rate (drive-mode's amount rules, as item 12). The action stays in sats:
      // P2 pins routing_lapsed's action as unchanged by a rate.
      const amount = renewalAmount(status.price_sats, usdRate);
      const context = "Hosted services are paused: valuation, Auto-Buy and stablecoin settlement data.";
      return {
        render: true,
        severity: bannerSeverityForTier(tier),
        headline: "Your membership payment is overdue",
        body: `${context} Pay ${amount.text} to restore them.`,
        context,
        actionLabel: `Renew ${price}`,
      };
    }
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
 *  this is just the headline/body. The price alert reads its context's
 *  reason. The pay-from-node lines were approved at the screenshot gate
 *  (pay-from-node spec §6 Q3): G3, 2026-11-06, rewrote the settlement-overdue
 *  alert (rulings R5, R6) and left the price alert's lines as drafted. */
export function autoPayAlertContent(
  type: string,
  context?: Record<string, unknown> | null,
): { headline: string; body: string } {
  switch (type) {
    case "AUTOPAY_SETTLEMENT_OVERDUE":
      return {
        // G3 rulings R5 and R6, 2026-11-06. The body promises only what paying
        // again delivers, a renewal: a confirmed payment under tolerance is
        // never credited, so "if it does not confirm" promised a resolution
        // that confirming does not bring.
        headline: "Auto-pay is on hold",
        body:
          "A payment your node sent hasn't been credited after 48 hours, and it may never be. " +
          "Auto-pay won't pay while it's outstanding. " +
          "To renew now, pay from this node and choose Send another payment.",
      };
    case "AUTOPAY_PRICE_NOT_ACKNOWLEDGED":
      return context?.reason === "no_acknowledged_price"
        ? {
            headline: "Auto-pay needs you to accept the price",
            body: "Auto-pay won't pay until you accept the subscription price. Pay from this node once, or accept the price shown.",
          }
        : {
            headline: "Auto-pay is paused: the price went up",
            body: "Auto-pay won't pay the new subscription price until you accept it.",
          };
    // treasury-price-trust (spec §8): the S1–S6 draft copy, split at its
    // first sentence (paymentTrust.ts). DRAFT until the screenshot gate.
    case "AUTOPAY_STATUS_UNVERIFIED":
    case "AUTOPAY_PAY_TARGET_REFUSED": {
      const c = context ?? {};
      const trust =
        type === "AUTOPAY_STATUS_UNVERIFIED"
          ? trustStateOfRefusal("status_unverified", { reason: c.verdict, verification_reason: c.verification_reason })
          : trustStateOfRefusal(String(c.reason ?? ""), c);
      if (!trust) return { headline: "Auto-pay update", body: "" };
      const { headline, body } = trustCopy(
        trust,
        trust.state === "S4_price_above_cap" ? renewalAmount(trust.price_sats, null).text : undefined,
      );
      return { headline, body };
    }
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
