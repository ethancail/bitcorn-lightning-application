// J9 / J9a (P6-3): the lapse banners that refuse payments or announce a close
// stay on top on a phone; every other subscription notice goes below the
// headline numbers.

import { describe, expect, it } from "vitest";
import type { SubscriptionStatus, SubscriptionTier } from "../api/client";
import { subscriptionBannerSlot } from "./subscriptionBannerSlot";

const status = (current_tier: SubscriptionTier): SubscriptionStatus => ({
  applicable: true,
  member_pubkey: "03" + "a".repeat(64),
  current_tier,
  paid_through: 0,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bcrt1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
});

describe("subscriptionBannerSlot", () => {
  it("routing_lapsed — payments through the hub are refused — stays on top", () => {
    expect(subscriptionBannerSlot(status("routing_lapsed"))).toBe("top");
  });

  it("close_due — the channel close is coming — stays on top", () => {
    expect(subscriptionBannerSlot(status("close_due"))).toBe("top");
  });

  it("worker_lapsed says neither (routing still works) — the info slot", () => {
    expect(subscriptionBannerSlot(status("worker_lapsed"))).toBe("info");
  });

  it("prepay — activate your membership — the info slot", () => {
    expect(subscriptionBannerSlot(status("prepay"))).toBe("info");
  });

  it("a current member, a not-applicable node and a status not yet loaded — the info slot", () => {
    expect(subscriptionBannerSlot(status("current"))).toBe("info");
    expect(subscriptionBannerSlot({ applicable: false, reason: "external_peer" } as SubscriptionStatus)).toBe("info");
    expect(subscriptionBannerSlot(null)).toBe("info");
  });
});
