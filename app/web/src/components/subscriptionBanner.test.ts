import { describe, it, expect } from "vitest";
import {
  bannerFor,
  settingsBadgeFor,
  bannerSeverityForTier,
  gatedTierOf,
  priceChangeBannerFor,
  autoPayAlertContent,
  autoPayBadgeSeverity,
  combineBadges,
} from "./subscriptionBanner";
import type {
  SubscriptionStatus,
  SubscriptionStatusApplicable,
  SubscriptionTier,
  SubscriptionNotApplicableReason,
  AutoPayConfig,
} from "../api/client";

const PRICE = 50_000;
const NOW = 1_700_000_000_000; // fixed reference instant for determinism

// A fixed paid_through; the banner formats it via toLocaleDateString,
// which is locale/TZ-dependent, so the assertions below check the
// stable parts of the copy (headline / action label / amount / day
// count) rather than the formatted date string itself.
const PAID_THROUGH = 1_690_000_000_000;

function applicable(
  tier: SubscriptionTier,
  overrides: Partial<SubscriptionStatusApplicable> = {},
): SubscriptionStatusApplicable {
  return {
    applicable: true,
    member_pubkey: "02abc",
    current_tier: tier,
    paid_through: PAID_THROUGH,
    price_sats: PRICE,
    period_days: 30,
    deposit_address: "bc1qexampledepositaddress",
    last_payment_at: null,
    last_payment_txid: null,
    grace: {
      fresh_until: NOW + 30 * 86_400_000,
      worker_until: PAID_THROUGH + 7 * 86_400_000,
      routing_until: PAID_THROUGH + 30 * 86_400_000,
      close_at: NOW + 5 * 86_400_000, // 5 days out from NOW by default
    },
    ...overrides,
  };
}

function notApplicable(
  reason: SubscriptionNotApplicableReason,
): SubscriptionStatus {
  return { applicable: false, reason };
}

const NOT_APPLICABLE_REASONS: SubscriptionNotApplicableReason[] = [
  "external_peer",
  "unclassified",
  "not_yet_allocated",
  "missing",
  "no_channel",
];

describe("bannerFor — gated tiers render with correct severity/copy", () => {
  it("prepay → info strip, Pay action, amount carried", () => {
    const d = bannerFor(applicable("prepay"), NOW);
    expect(d.render).toBe(true);
    expect(d.severity).toBe("info");
    expect(d.headline).toBe("Welcome to BitCorn — activate your membership");
    expect(d.body).toContain("50,000 sats");
    expect(d.actionLabel).toBe("Pay 50,000 sats");
  });

  it("worker_lapsed → amber, Renew action", () => {
    const d = bannerFor(applicable("worker_lapsed"), NOW);
    expect(d.render).toBe(true);
    expect(d.severity).toBe("amber");
    expect(d.headline).toBe("Action needed: hosted services lapsed");
    expect(d.actionLabel).toBe("Renew 50,000 sats");
    expect(d.body).toContain("routing still work");
  });

  it("routing_lapsed → orange, Renew action", () => {
    const d = bannerFor(applicable("routing_lapsed"), NOW);
    expect(d.render).toBe(true);
    expect(d.severity).toBe("orange");
    expect(d.headline).toBe("Urgent: routing access blocked");
    expect(d.actionLabel).toBe("Renew 50,000 sats");
    expect(d.body).toContain("refused until you renew");
  });

  it("close_due → red, halt-close action, imminent (no countdown)", () => {
    const d = bannerFor(applicable("close_due"), NOW);
    expect(d.render).toBe(true);
    expect(d.severity).toBe("red");
    expect(d.headline).toBe("Critical: channel close imminent");
    expect(d.actionLabel).toBe("Pay now to halt close");
    expect(d.body).toContain("queued");
    expect(d.body).toContain("halts it");
    expect(d.body).toContain("50,000 sats");
  });

  it("close_due never renders a countdown — close_at is always past for close_due", () => {
    // By construction (tierDispatch §5) close_due ⟺ now > paid_through +
    // grace_days_close = close_at, so a real close_at is always in the
    // past. The banner must not show "~N days" (would be non-positive).
    const pastClose = { ...applicable("close_due").grace, close_at: NOW - 86_400_000 };
    const d = bannerFor(applicable("close_due", { grace: pastClose }), NOW);
    expect(d.body).not.toMatch(/~-?\d/);     // no "~N" / "~-N" day token
    expect(d.body).not.toContain("days");
    expect(d.body).not.toContain("NaN");
  });

  it("price flows from status.price_sats, never hardcoded 50k", () => {
    const d = bannerFor(applicable("prepay", { price_sats: 75_000 }), NOW);
    expect(d.actionLabel).toBe("Pay 75,000 sats");
    expect(d.body).toContain("75,000 sats");
  });
});

describe("bannerFor — non-rendering states", () => {
  it("current → render:false (absence is the signal)", () => {
    expect(bannerFor(applicable("current"), NOW).render).toBe(false);
  });

  it("each applicable:false reason → render:false", () => {
    for (const reason of NOT_APPLICABLE_REASONS) {
      expect(bannerFor(notApplicable(reason), NOW).render).toBe(false);
    }
  });

  it("null status → render:false", () => {
    expect(bannerFor(null, NOW).render).toBe(false);
  });
});

describe("settingsBadgeFor — severity per tier", () => {
  it("maps each gated tier to its badge severity", () => {
    expect(settingsBadgeFor(applicable("prepay"))).toEqual({ show: true, severity: "blue" });
    expect(settingsBadgeFor(applicable("worker_lapsed"))).toEqual({ show: true, severity: "amber" });
    expect(settingsBadgeFor(applicable("routing_lapsed"))).toEqual({ show: true, severity: "orange" });
    expect(settingsBadgeFor(applicable("close_due"))).toEqual({ show: true, severity: "red" });
  });

  it("hidden for current, every not-applicable reason, and null", () => {
    expect(settingsBadgeFor(applicable("current")).show).toBe(false);
    for (const reason of NOT_APPLICABLE_REASONS) {
      expect(settingsBadgeFor(notApplicable(reason)).show).toBe(false);
    }
    expect(settingsBadgeFor(null).show).toBe(false);
  });
});

describe("shared severity map — banner and badge agree on the lapsed family", () => {
  it("bannerSeverityForTier matches the banner descriptor severity", () => {
    expect(bannerSeverityForTier("prepay")).toBe("info");
    expect(bannerSeverityForTier("worker_lapsed")).toBe("amber");
    expect(bannerSeverityForTier("routing_lapsed")).toBe("orange");
    expect(bannerSeverityForTier("close_due")).toBe("red");
  });
});

function autoPay(over: Partial<AutoPayConfig> = {}): AutoPayConfig {
  return {
    enabled: true,
    enabled_at: 1,
    last_acknowledged_price: 50_000,
    last_acknowledged_price_at: 1,
    current_price: 50_000,
    price_change_pending: false,
    active_alerts: [],
    badge: { active_count: 0, highest_severity: null },
    ...over,
  };
}

describe("priceChangeBannerFor — non-dismissible price-change banner", () => {
  it("does not render for null config or when not pending", () => {
    expect(priceChangeBannerFor(null).render).toBe(false);
    expect(priceChangeBannerFor(autoPay({ price_change_pending: false })).render).toBe(false);
  });

  it("renders with the new and previous prices when pending", () => {
    const d = priceChangeBannerFor(
      autoPay({ price_change_pending: true, current_price: 60_000, last_acknowledged_price: 50_000 }),
    );
    expect(d.render).toBe(true);
    expect(d.headline).toMatch(/price/i);
    expect(d.body).toContain("60,000");
    expect(d.body).toContain("50,000");
  });
});

describe("autoPayAlertContent — copy per alert type", () => {
  it("gives every failure type a non-empty headline + body", () => {
    for (const t of [
      "AUTOPAY_INSUFFICIENT_FUNDS",
      "AUTOPAY_LND_UNAVAILABLE",
      "AUTOPAY_PAYMENT_FAILED",
      "AUTOPAY_FEE_ESTIMATE_FAILED",
    ] as const) {
      const c = autoPayAlertContent(t);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it("frames AUTOPAY_SUCCEEDED as a renewal notice", () => {
    expect(autoPayAlertContent("AUTOPAY_SUCCEEDED").headline).toMatch(/renew/i);
  });
});

describe("autoPayBadgeSeverity — nav badge from auto-pay state", () => {
  it("null for no config / no signal", () => {
    expect(autoPayBadgeSeverity(null)).toBeNull();
    expect(autoPayBadgeSeverity(autoPay())).toBeNull();
  });

  it("amber for a pending price change", () => {
    expect(autoPayBadgeSeverity(autoPay({ price_change_pending: true }))).toBe("amber");
  });

  it("amber for an active warning alert", () => {
    expect(
      autoPayBadgeSeverity(autoPay({ badge: { active_count: 1, highest_severity: "warning" } })),
    ).toBe("amber");
  });

  it("blue for an active info-only alert", () => {
    expect(
      autoPayBadgeSeverity(autoPay({ badge: { active_count: 1, highest_severity: "info" } })),
    ).toBe("blue");
  });
});

describe("combineBadges — highest severity across tier + auto-pay", () => {
  it("tier red outranks auto-pay amber", () => {
    expect(combineBadges({ show: true, severity: "red" }, "amber")).toEqual({
      show: true,
      severity: "red",
    });
  });

  it("auto-pay amber shows when there is no tier badge", () => {
    expect(combineBadges({ show: false }, "amber")).toEqual({ show: true, severity: "amber" });
  });

  it("hidden when neither signal is present", () => {
    expect(combineBadges({ show: false }, null)).toEqual({ show: false });
  });

  it("tier amber outranks auto-pay blue", () => {
    expect(combineBadges({ show: true, severity: "amber" }, "blue")).toEqual({
      show: true,
      severity: "amber",
    });
  });
});

describe("gatedTierOf", () => {
  it("extracts the four gated tiers and rejects current/not-applicable/null", () => {
    expect(gatedTierOf(applicable("prepay"))).toBe("prepay");
    expect(gatedTierOf(applicable("close_due"))).toBe("close_due");
    expect(gatedTierOf(applicable("current"))).toBeNull();
    expect(gatedTierOf(notApplicable("no_channel"))).toBeNull();
    expect(gatedTierOf(null)).toBeNull();
  });
});
