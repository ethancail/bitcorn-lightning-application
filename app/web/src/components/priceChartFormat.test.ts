import { describe, it, expect } from "vitest";
import { niceTicks, formatAxisPrice, formatTimeLabel } from "./priceChartFormat";

describe("niceTicks", () => {
  it("turns the reported 5y range ($13k–$128k) into round $50k ticks", () => {
    expect(niceTicks(13_000, 128_000, 5)).toEqual([0, 50_000, 100_000, 150_000]);
  });

  it("adapts the interval to a tight 24h range (~$900 → $250 step)", () => {
    const ticks = niceTicks(62_800, 63_700, 5);
    const step = ticks[1] - ticks[0];
    expect(step).toBe(250);
    expect(ticks[0]).toBe(62_750);
    expect(ticks.at(-1)).toBe(63_750);
  });

  it("adapts to a lower-price 1y range ($18k–$42k → $10k step, not $1k)", () => {
    const ticks = niceTicks(18_000, 42_000, 5);
    const step = ticks[1] - ticks[0];
    expect(step).toBe(10_000);
    // every tick is a round multiple of the step
    expect(ticks.every((t) => t % step === 0)).toBe(true);
  });

  it("always lands ticks on a round 1/2/2.5/5 × 10ⁿ interval", () => {
    for (const [lo, hi] of [[13_000, 128_000], [62_800, 63_700], [18_000, 42_000], [1_000, 9_000]]) {
      const ticks = niceTicks(lo, hi, 5);
      const step = ticks[1] - ticks[0];
      const norm = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 2.5, 5, 10]).toContain(norm);
    }
  });

  it("is order-independent (max,min == min,max)", () => {
    expect(niceTicks(128_000, 13_000, 5)).toEqual(niceTicks(13_000, 128_000, 5));
  });

  it("returns a single value for a degenerate range (min === max)", () => {
    expect(niceTicks(50_000, 50_000, 5)).toEqual([50_000]);
  });

  it("does not throw on non-finite input", () => {
    expect(() => niceTicks(NaN, 5, 5)).not.toThrow();
    expect(() => niceTicks(10, Infinity, 5)).not.toThrow();
  });
});

describe("formatAxisPrice", () => {
  it("renders whole thousands without a decimal", () => {
    expect(formatAxisPrice(63_000)).toBe("$63k");
    expect(formatAxisPrice(150_000)).toBe("$150k");
  });

  it("keeps one decimal for non-round thousands (tight-range labels don't collide)", () => {
    expect(formatAxisPrice(62_800)).toBe("$62.8k");
    expect(formatAxisPrice(62_750)).toBe("$62.8k"); // 62.75 → 62.8
  });

  it("renders zero as $0 (the nice-floor of wide ranges)", () => {
    expect(formatAxisPrice(0)).toBe("$0");
  });

  it("falls back to a plain dollar amount below $1k", () => {
    expect(formatAxisPrice(500)).toBe("$500");
  });
});

describe("formatTimeLabel", () => {
  // Mid-month, midday UTC keeps the month/year stable across runner TZs.
  const at = (y: number, m0: number, d: number) => Math.floor(Date.UTC(y, m0, d, 12, 0, 0) / 1000);

  it("5y uses an apostrophe-year — 'Jul \\'21', NOT a day-style 'Jul 21'", () => {
    const label = formatTimeLabel(at(2021, 6, 15), "5y");
    expect(label).toBe("Jul '21");
    expect(label).toMatch(/^[A-Z][a-z]{2} '\d{2}$/); // apostrophe disambiguator present
  });

  it("1y also carries the year (kills the year-boundary ambiguity)", () => {
    expect(formatTimeLabel(at(2026, 0, 15), "1y")).toBe("Jan '26");
  });

  it("30d is a real month+day, no year", () => {
    expect(formatTimeLabel(at(2026, 5, 8), "30d")).toBe("Jun 8");
  });

  it("7d is a weekday short name", () => {
    expect(formatTimeLabel(at(2026, 5, 8), "7d")).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  it("24h is a clock time", () => {
    expect(formatTimeLabel(at(2026, 5, 8), "24h")).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });
});
