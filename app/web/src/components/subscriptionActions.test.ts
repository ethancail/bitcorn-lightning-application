import { describe, it, expect } from "vitest";
import {
  actionsFor,
  isOnrampPrimary,
  ONRAMP_PRIMARY_TIERS,
} from "./subscriptionActions";

const PRICE = 50_000;

describe("isOnrampPrimary", () => {
  it("classifies the four Onramp-primary states and excludes current", () => {
    expect(ONRAMP_PRIMARY_TIERS).toEqual([
      "prepay",
      "worker_lapsed",
      "routing_lapsed",
      "close_due",
    ]);
    for (const t of ONRAMP_PRIMARY_TIERS) expect(isOnrampPrimary(t)).toBe(true);
    expect(isOnrampPrimary("current")).toBe(false);
  });
});

describe("actionsFor — both buttons carry a handler-bearing kind in all four states", () => {
  // This is the regression guard for the inert-button bug: a button
  // with kind other than "none" maps to a real handler in the panel.
  it.each(ONRAMP_PRIMARY_TIERS)("%s has Onramp primary + pay-modal secondary", (tier) => {
    const a = actionsFor(tier, PRICE);
    expect(a.primary?.kind).toBe("onramp");
    expect(a.secondary?.kind).toBe("pay-modal");
    // Labels are non-empty and the secondary names the amount where applicable.
    expect(a.primary?.label).toBe("Open Coinbase Onramp");
    expect(a.primary?.glyph).toBe("↗");
    expect(a.secondary?.label.length).toBeGreaterThan(0);
  });

  it("prepay's secondary says 'pay' with the amount and has no tertiary", () => {
    const a = actionsFor("prepay", PRICE);
    expect(a.secondary?.label).toBe("I have BTC — pay 50,000 sats");
    expect(a.tertiary).toBeUndefined();
  });

  it("worker_lapsed is relabeled to the Onramp-primary pattern (no 'Buy BTC with card')", () => {
    const a = actionsFor("worker_lapsed", PRICE);
    expect(a.primary?.label).toBe("Open Coinbase Onramp");
    expect(a.secondary?.label).toBe("I have BTC — renew (50,000 sats)");
    expect(a.tertiary?.kind).toBe("history");
  });

  it("routing_lapsed renews with the amount and shows history", () => {
    const a = actionsFor("routing_lapsed", PRICE);
    expect(a.secondary?.label).toBe("I have BTC — renew (50,000 sats)");
    expect(a.tertiary?.kind).toBe("history");
  });

  it("close_due's secondary halts the close and shows history", () => {
    const a = actionsFor("close_due", PRICE);
    expect(a.secondary?.label).toBe("I have BTC — pay now to halt close");
    expect(a.tertiary?.kind).toBe("history");
  });
});

describe("actionsFor — current (not Onramp-primary) is unchanged in shape", () => {
  it("keeps renew / refresh / history", () => {
    const a = actionsFor("current", PRICE);
    expect(a.primary?.kind).toBe("renew");
    expect(a.secondary?.kind).toBe("refresh");
    expect(a.tertiary?.kind).toBe("history");
  });
});
