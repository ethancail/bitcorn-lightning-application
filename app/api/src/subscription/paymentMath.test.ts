import { describe, it, expect } from "vitest";
import {
  attributePayment,
  computeNewPaidThrough,
  type SubscriptionPolicySnapshot,
} from "./paymentMath";

// Coverage for the subscription detector's *decision* logic, per the
// 2026-06-11 detector discrimination audit. paymentMath holds the pure
// half of the detector (attribution amount-floor + pro-rata extension,
// and the paid_through stacking rule); detector.test.ts covers the
// orchestration guards around it.
//
// Canonical policy (migration 036 defaults): 50,000 sats / 30 days /
// 95% underpay tolerance.
const POLICY: SubscriptionPolicySnapshot = {
  price_sats: 50_000,
  period_days: 30,
  underpay_tolerance_pct: 95,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("attributePayment — amount → credit vs pending (audit §3)", () => {
  it("case 1: exact price (50,000) credits a full 30-day period", () => {
    expect(attributePayment(50_000, POLICY)).toEqual({
      kind: "credit",
      period_extension_days: 30,
    });
  });

  it("case 2: underpayment below 95% tolerance (47,499) → pending bucket, not credited", () => {
    const out = attributePayment(47_499, POLICY);
    expect(out.kind).toBe("pending_attribution");
    // tolerance floor is 47,500 sats (95% of 50,000); 47,499 is one sat under
    if (out.kind === "pending_attribution") {
      expect(out.reason).toMatch(/95% tolerance/);
    }
  });

  it("case 3: exactly at tolerance (47,500 = 95%) credits 28 days (floor of 28.5)", () => {
    expect(attributePayment(47_500, POLICY)).toEqual({
      kind: "credit",
      period_extension_days: 28,
    });
  });

  it("case 4: overpayment (100,000 = 2×) credits 60 days, no cap", () => {
    expect(attributePayment(100_000, POLICY)).toEqual({
      kind: "credit",
      period_extension_days: 60,
    });
  });

  it("credits floor partial periods (75,000 = 1.5× → 45 days)", () => {
    expect(attributePayment(75_000, POLICY)).toEqual({
      kind: "credit",
      period_extension_days: 45,
    });
  });

  // Case 11 — DEFENSIVE GUARD, not a live scenario. LND never emits a
  // UTXO with a zero or negative value, so the detector never feeds such
  // an amount to attributePayment in practice. This test documents that
  // the guard exists and diverts to the pending bucket rather than
  // crediting nonsense, so a future edit can't silently weaken it.
  it("case 11 (defensive guard): zero / negative / non-finite amount → pending, never credit", () => {
    for (const bad of [0, -1, -50_000, NaN, Infinity, -Infinity]) {
      const out = attributePayment(bad, POLICY);
      expect(out.kind).toBe("pending_attribution");
    }
  });

  it("tolerance scales with policy (a 0% tolerance credits any positive amount)", () => {
    const lenient: SubscriptionPolicySnapshot = { ...POLICY, underpay_tolerance_pct: 0 };
    expect(attributePayment(1, lenient).kind).toBe("credit");
  });
});

describe("computeNewPaidThrough — stacking rule (audit §3 case 6)", () => {
  // Use fixed timestamps (no Date.now()): the function takes nowMs explicitly.
  const NOW = 1_800_000_000_000;

  it("case 6a: early payment (current paid_through in the FUTURE) stacks from current", () => {
    const future = NOW + 10 * MS_PER_DAY;
    // 30-day extension should append to the existing future date, not reset to now.
    expect(computeNewPaidThrough(future, 30, NOW)).toBe(future + 30 * MS_PER_DAY);
  });

  it("case 6b: late payment (current paid_through in the PAST) resets from now", () => {
    const past = NOW - 10 * MS_PER_DAY;
    expect(computeNewPaidThrough(past, 30, NOW)).toBe(NOW + 30 * MS_PER_DAY);
  });

  it("boundary: now exactly equal to current paid_through stacks from current", () => {
    expect(computeNewPaidThrough(NOW, 30, NOW)).toBe(NOW + 30 * MS_PER_DAY);
  });

  it("case 5 (math): two sequential credits to a paid-up member stack cumulatively", () => {
    // First payment while lapsed (past) resets from now → +30d.
    const afterFirst = computeNewPaidThrough(NOW - MS_PER_DAY, 30, NOW);
    expect(afterFirst).toBe(NOW + 30 * MS_PER_DAY);
    // Second payment shortly after, now within the paid window → stacks → +60d total.
    const afterSecond = computeNewPaidThrough(afterFirst, 30, NOW + MS_PER_DAY);
    expect(afterSecond).toBe(afterFirst + 30 * MS_PER_DAY);
    expect(afterSecond).toBe(NOW + 60 * MS_PER_DAY);
  });
});
