// Coverage for the rail's entitlement descriptor.
//
// THE TRAP THIS FILE EXISTS TO AVOID: a fixture set built entirely from
// `current`-tier statuses would pass whether or not the gate exists. Every
// discriminating case below names a NON-current tier explicitly, and the
// fresh-grace case is asserted as its own property because trial access is a
// deliberate decision that must fail loudly if someone removes it.

import { describe, it, expect } from "vitest";
import { isRailGated, railAccessFor, railGateNoticeFor } from "./railAccess";
import type {
  SubscriptionStatus,
  SubscriptionTier,
  SubscriptionNotApplicableReason,
} from "../api/client";

function status(tier: SubscriptionTier, over: Record<string, unknown> = {}): SubscriptionStatus {
  return {
    applicable: true,
    member_pubkey: "02".padEnd(66, "a"),
    current_tier: tier,
    paid_through: 1_700_000_000_000,
    price_sats: 50_000,
    period_days: 30,
    deposit_address: "bc1qexampleexampleexample",
    last_payment_at: null,
    last_payment_txid: null,
    grace: {
      fresh_until: 1_700_000_000_000,
      worker_until: 1_700_000_000_000,
      routing_until: 1_700_000_000_000,
      close_at: 1_700_000_000_000,
    },
    ...over,
  } as SubscriptionStatus;
}

function notApplicable(reason: SubscriptionNotApplicableReason): SubscriptionStatus {
  return { applicable: false, reason } as SubscriptionStatus;
}

const GATED_TIERS: SubscriptionTier[] = [
  "prepay",
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
];

describe("railAccessFor", () => {
  it("reports `entitled` for a paid current member", () => {
    expect(railAccessFor(status("current"))).toEqual({ kind: "entitled" });
  });

  it("reports `entitled` for a fresh-grace member who has NEVER paid", () => {
    // The deliberate trial-access property. A never-paid node inside its 30-day
    // fresh-grace window carries tier `current` and a full-scope token, so it
    // keeps the rail. last_payment_txid === null is what makes this row
    // unambiguously never-paid rather than merely current.
    const freshGrace = status("current", {
      last_payment_txid: null,
      last_payment_at: null,
    });
    expect(railAccessFor(freshGrace)).toEqual({ kind: "entitled" });
    expect(isRailGated(freshGrace)).toBe(false);
    expect(railGateNoticeFor(freshGrace).render).toBe(false);
  });

  it.each(GATED_TIERS)("reports `gated` for %s", (tier) => {
    expect(railAccessFor(status(tier))).toEqual({ kind: "gated", tier });
    expect(isRailGated(status(tier))).toBe(true);
  });

  it("reports `unknown` for a not-yet-fetched status (fails OPEN)", () => {
    // Must not gate: useSubscriptionStatus starts null and polls at 60s, so
    // gating here would hide the rail from healthy paying members on every load.
    expect(railAccessFor(null)).toEqual({ kind: "unknown" });
    expect(isRailGated(null)).toBe(false);
  });

  it.each<SubscriptionNotApplicableReason>([
    "external_peer",
    "unclassified",
    "not_yet_allocated",
    "missing",
    "no_channel",
  ])("reports `unknown` (fails OPEN) for applicable:false / %s", (reason) => {
    expect(railAccessFor(notApplicable(reason))).toEqual({ kind: "unknown" });
    expect(isRailGated(notApplicable(reason))).toBe(false);
  });
});

describe("railGateNoticeFor", () => {
  it("does not render for an entitled member", () => {
    expect(railGateNoticeFor(status("current"))).toEqual({ render: false });
  });

  it("does not render when status is unknown", () => {
    expect(railGateNoticeFor(null)).toEqual({ render: false });
    expect(railGateNoticeFor(notApplicable("no_channel"))).toEqual({ render: false });
  });

  it.each(GATED_TIERS)("renders a headline and body for %s", (tier) => {
    const notice = railGateNoticeFor(status(tier));
    expect(notice.render).toBe(true);
    expect(notice.headline).toBeTruthy();
    expect(notice.body).toBeTruthy();
    expect(notice.severity).toBeTruthy();
  });

  it("escalates severity across the lapsed ladder", () => {
    // Derived from the shared SEVERITY_BY_TIER map, so the rail notice can't
    // drift in color from the dashboard banner or the 402 notice.
    expect(railGateNoticeFor(status("prepay")).severity).toBe("info");
    expect(railGateNoticeFor(status("worker_lapsed")).severity).toBe("amber");
    expect(railGateNoticeFor(status("routing_lapsed")).severity).toBe("orange");
    expect(railGateNoticeFor(status("close_due")).severity).toBe("red");
  });

  it("gives prepay activation copy, not renewal copy", () => {
    // A member who never paid isn't "paused" — nothing was ever running.
    expect(railGateNoticeFor(status("prepay")).headline).toMatch(/active membership/i);
    expect(railGateNoticeFor(status("worker_lapsed")).headline).toMatch(/paused/i);
  });

  it.each(GATED_TIERS)("never implies %s has lost custody of funds", (tier) => {
    // The rail is non-custodial. Copy must say the money is fine and only
    // Bitcorn's view lapsed — the whole point of distinguishing this from the
    // staleness banner is honesty about what actually broke.
    const notice = railGateNoticeFor(status(tier));
    expect(`${notice.headline} ${notice.body}`).toMatch(/untouched and still yours/i);
  });
});
