import { describe, expect, it } from "vitest";
import { classifyZone, Zone } from "../../src/valuation/zones";

describe("classifyZone", () => {
  const cases: Array<[number, Zone, number]> = [
    [-3.0,  "extreme_buy",   3.0],
    [-2.01, "extreme_buy",   3.0],
    [-2.0,  "undervalued",   2.0],
    [-1.5,  "undervalued",   2.0],
    [-1.01, "undervalued",   2.0],
    [-1.0,  "fair_value",    1.0],
    [ 0.0,  "fair_value",    1.0],
    [ 0.99, "fair_value",    1.0],
    [ 1.0,  "elevated",      0.5],
    [ 1.49, "elevated",      0.5],
    [ 1.5,  "overvalued",    0.25],
    [ 2.49, "overvalued",    0.25],
    [ 2.5,  "extreme_sell",  0.0],
    [ 5.72, "extreme_sell",  0.0],
  ];

  it.each(cases)("Z=%f classifies to %s with multiplier %f", (z, expectedZone, expectedMult) => {
    const result = classifyZone(z);
    expect(result.zone).toBe(expectedZone);
    expect(result.multiplier).toBeCloseTo(expectedMult, 10);
  });

  it("returns fair_value with multiplier 0 for non-finite input (neutral no-buy)", () => {
    // Previously defaulted to extreme_sell on NaN, which combined with
    // engine.ts's NaN→0 coercion produced a misleading "Z=0, Extreme Sell"
    // display. fair_value + multiplier 0 is the honest default: we don't
    // know what the zone is, so don't buy, don't sell, don't mislead.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = classifyZone(bad);
      expect(result.zone).toBe("fair_value");
      expect(result.multiplier).toBe(0);
    }
  });
});
