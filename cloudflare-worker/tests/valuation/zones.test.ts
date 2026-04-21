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

  it("returns extreme_sell for NaN (safe default)", () => {
    const result = classifyZone(Number.NaN);
    expect(result.zone).toBe("extreme_sell");
    expect(result.multiplier).toBe(0);
  });
});
