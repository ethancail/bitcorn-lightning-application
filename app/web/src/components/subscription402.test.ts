import { describe, it, expect } from "vitest";
import { is402SubscriptionDenied, extract402Payload } from "./subscription402";

// Mimics what apiFetch throws: an Error with status/code/body attached.
function thrownError(attrs: Record<string, unknown>): unknown {
  return Object.assign(new Error("err"), attrs);
}

// A genuine Tier 2 routing-denial 402 (tier2Gate.ts Tier2DenialBody).
const DENIAL = thrownError({
  status: 402,
  code: "subscription_routing_denied",
  body: {
    error: "subscription_routing_denied",
    tier: "prepay",
    paid_through: 1_690_000_000_000,
    deposit_address: "bc1qdeposit",
    price_sats: 50_000,
  },
});

describe("is402SubscriptionDenied", () => {
  it("true for a real subscription routing denial (402 + matching code)", () => {
    expect(is402SubscriptionDenied(DENIAL)).toBe(true);
  });

  // THE TRAP: /api/network/pay returns 402 for ordinary failed payments
  // too, with an arbitrary LND error string. Status alone must NOT match.
  it("false for a 402 with a non-denial code (ordinary failed payment)", () => {
    const failedPayment = thrownError({
      status: 402,
      code: "payment_failed",
      body: { ok: false, error: "no_route", failure_reason: "NO_ROUTE" },
    });
    expect(is402SubscriptionDenied(failedPayment)).toBe(false);
  });

  it("false when the 402 carries no code at all", () => {
    expect(is402SubscriptionDenied(thrownError({ status: 402 }))).toBe(false);
  });

  it("false for the right code at the wrong status (403/500)", () => {
    expect(is402SubscriptionDenied(thrownError({ status: 403, code: "subscription_routing_denied" }))).toBe(false);
    expect(is402SubscriptionDenied(thrownError({ status: 500, code: "subscription_routing_denied" }))).toBe(false);
  });

  it("false for non-object / undefined / null input", () => {
    expect(is402SubscriptionDenied(undefined)).toBe(false);
    expect(is402SubscriptionDenied(null)).toBe(false);
    expect(is402SubscriptionDenied("402")).toBe(false);
    expect(is402SubscriptionDenied(402)).toBe(false);
  });
});

describe("extract402Payload", () => {
  it("round-trips a well-formed denial body", () => {
    expect(extract402Payload(DENIAL)).toEqual({
      tier: "prepay",
      paid_through: 1_690_000_000_000,
      deposit_address: "bc1qdeposit",
      price_sats: 50_000,
    });
  });

  it("returns null when recognition fails (not a denial)", () => {
    const failedPayment = thrownError({ status: 402, code: "payment_failed", body: { error: "no_route" } });
    expect(extract402Payload(failedPayment)).toBeNull();
  });

  it("nulls a missing deposit_address and paid_through rather than crashing", () => {
    const partial = thrownError({
      status: 402,
      code: "subscription_routing_denied",
      body: { error: "subscription_routing_denied", tier: "routing_lapsed", price_sats: 50_000 },
    });
    expect(extract402Payload(partial)).toEqual({
      tier: "routing_lapsed",
      paid_through: null,
      deposit_address: null,
      price_sats: 50_000,
    });
  });

  it("falls back price_sats to 0 (→ '— sats' via fmtSats) when non-numeric", () => {
    const badPrice = thrownError({
      status: 402,
      code: "subscription_routing_denied",
      body: { error: "subscription_routing_denied", tier: "close_due", price_sats: "lots" },
    });
    expect(extract402Payload(badPrice)?.price_sats).toBe(0);
  });

  it("returns null when the body lacks a usable tier", () => {
    const noTier = thrownError({
      status: 402,
      code: "subscription_routing_denied",
      body: { error: "subscription_routing_denied", price_sats: 50_000 },
    });
    expect(extract402Payload(noTier)).toBeNull();
  });

  it("never throws on malformed bodies (string, empty, wrong types)", () => {
    const cases = [
      thrownError({ status: 402, code: "subscription_routing_denied", body: "nope" }),
      thrownError({ status: 402, code: "subscription_routing_denied", body: {} }),
      thrownError({ status: 402, code: "subscription_routing_denied", body: null }),
      thrownError({ status: 402, code: "subscription_routing_denied" }), // no body key
    ];
    for (const c of cases) {
      expect(() => extract402Payload(c)).not.toThrow();
      expect(extract402Payload(c)).toBeNull();
    }
  });
});
