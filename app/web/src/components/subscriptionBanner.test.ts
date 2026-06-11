import { describe, it, expect } from "vitest";
import {
  bannerFor,
  settingsBadgeFor,
  bannerSeverityForTier,
  gatedTierOf,
} from "./subscriptionBanner";
import type {
  SubscriptionStatus,
  SubscriptionStatusApplicable,
  SubscriptionTier,
  SubscriptionNotApplicableReason,
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

describe("gatedTierOf", () => {
  it("extracts the four gated tiers and rejects current/not-applicable/null", () => {
    expect(gatedTierOf(applicable("prepay"))).toBe("prepay");
    expect(gatedTierOf(applicable("close_due"))).toBe("close_due");
    expect(gatedTierOf(applicable("current"))).toBeNull();
    expect(gatedTierOf(notApplicable("no_channel"))).toBeNull();
    expect(gatedTierOf(null)).toBeNull();
  });
});
