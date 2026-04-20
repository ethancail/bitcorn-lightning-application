import { describe, expect, it } from "vitest";
import { computeStats, toZScore, zScoreSeries } from "../../src/valuation/zscore";

describe("computeStats", () => {
  it("computes mean and sample stdev for a known series", () => {
    // Data: [2, 4, 4, 4, 5, 5, 7, 9]  → mean=5, sample stdev=2 (Bessel-corrected)
    const stats = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.mean).toBeCloseTo(5.0, 10);
    expect(stats.stdev).toBeCloseTo(2.138089935, 6);
  });

  it("returns stdev=0 for a constant series", () => {
    const stats = computeStats([3, 3, 3, 3]);
    expect(stats.mean).toBeCloseTo(3.0, 10);
    expect(stats.stdev).toBe(0);
  });

  it("throws on an empty series", () => {
    expect(() => computeStats([])).toThrow(/empty/);
  });
});

describe("toZScore", () => {
  it("returns (value - mean) / stdev", () => {
    const z = toZScore(7, { mean: 5, stdev: 2 });
    expect(z).toBeCloseTo(1.0, 10);
  });

  it("returns 0 when stdev is 0 (constant series)", () => {
    const z = toZScore(7, { mean: 5, stdev: 0 });
    expect(z).toBe(0);
  });
});

describe("zScoreSeries", () => {
  it("maps each value to its Z-score against the whole-series stats", () => {
    const result = zScoreSeries([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result.length).toBe(8);
    expect(result[0]).toBeCloseTo((2 - 5) / 2.138089935, 5);
    expect(result[4]).toBeCloseTo((5 - 5) / 2.138089935, 5);
    expect(result[7]).toBeCloseTo((9 - 5) / 2.138089935, 5);
  });
});
