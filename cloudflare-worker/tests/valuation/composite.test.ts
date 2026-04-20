import { describe, expect, it } from "vitest";
import { composite, INPUT_WEIGHTS } from "../../src/valuation/composite";

describe("INPUT_WEIGHTS", () => {
  it("defines exactly 12 inputs", () => {
    expect(Object.keys(INPUT_WEIGHTS).length).toBe(12);
  });

  it("all weights are positive and less than 1", () => {
    for (const [key, w] of Object.entries(INPUT_WEIGHTS)) {
      expect(w, `weight for ${key}`).toBeGreaterThan(0);
      expect(w, `weight for ${key}`).toBeLessThan(1);
    }
  });

  it("weights sum close to 1.0 (mockup rounding tolerance)", () => {
    const sum = Object.values(INPUT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.02);
  });
});

describe("composite", () => {
  it("computes a weighted sum and renormalises weights to 1.0", () => {
    // Three inputs, Z=1 each, weights [0.2, 0.3, 0.5] → sum = 1.0 naturally
    const z = composite({ a: 1, b: 1, c: 1 }, { a: 0.2, b: 0.3, c: 0.5 });
    expect(z).toBeCloseTo(1.0, 10);
  });

  it("renormalises when weights do not sum to 1.0", () => {
    // Weights [0.2, 0.3] sum to 0.5 → renormalised to [0.4, 0.6]
    // Z-scores [1, 2] → 0.4*1 + 0.6*2 = 1.6
    const z = composite({ a: 1, b: 2 }, { a: 0.2, b: 0.3 });
    expect(z).toBeCloseTo(1.6, 10);
  });

  it("ignores inputs missing from the readings map", () => {
    // c is in weights but not readings — we can't use it, so renormalise over {a,b}
    const z = composite({ a: 1, b: 2 }, { a: 0.2, b: 0.3, c: 0.5 });
    expect(z).toBeCloseTo(1.6, 10);
  });

  it("throws if no inputs overlap", () => {
    expect(() => composite({ x: 1 }, { a: 0.5, b: 0.5 })).toThrow(/no inputs/);
  });

  it("skips NaN/Infinity readings", () => {
    const z = composite({ a: 1, b: Number.NaN, c: 2 }, { a: 0.2, b: 0.3, c: 0.5 });
    // Only a and c are usable; renormalised weights: a=0.2/0.7, c=0.5/0.7
    const expected = (1 * 0.2 + 2 * 0.5) / (0.2 + 0.5);
    expect(z).toBeCloseTo(expected, 10);
  });
});
