import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { priceAxis, formatAxisPrice, formatTimeLabel, fittingTickCount, xAxisBand, X_TICK_SIZE } from "./priceChartFormat";

describe("priceAxis: round labels inside a fitted domain", () => {
  const RANGES: Array<[number, number]> = [
    [13_000, 128_000], [62_000, 64_500], [58_500, 66_000], [18_000, 42_000],
    [60_100, 130_900], [1_050, 9_990], [99_000, 101_000], [62_800, 63_700],
    [60_407, 61_007], [3_000, 110_000],
  ];

  // The guarantee that keeps the price chart from dropping labels:
  // never more than maxTicks, never fewer than two, all inside the domain.
  it("between 2 and maxTicks labels, every one inside the domain, the data inside too", () => {
    for (const [lo, hi] of RANGES) {
      for (const cap of [2, 3, 4, 5]) {
        const { domain, ticks } = priceAxis(lo, hi, cap);
        expect(ticks.length, `${lo}–${hi} cap ${cap}`).toBeGreaterThanOrEqual(2);
        expect(ticks.length, `${lo}–${hi} cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(ticks[0]).toBeGreaterThanOrEqual(domain[0]);
        expect(ticks.at(-1)!).toBeLessThanOrEqual(domain[1]);
        expect(domain[0]).toBeLessThanOrEqual(lo);
        expect(domain[1]).toBeGreaterThanOrEqual(hi);
      }
    }
  });

  it("lands labels on a uniform round 1/2/2.5/5 × 10ⁿ step", () => {
    for (const [lo, hi] of RANGES) {
      const { ticks } = priceAxis(lo, hi, 5);
      const step = ticks[1] - ticks[0];
      const norm = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 1.25, 2, 2.5, 5, 10]).toContain(norm);
      expect(ticks.every((t, i) => i === 0 || t - ticks[i - 1] === step)).toBe(true);
      expect(ticks.every((t) => t % step === 0)).toBe(true);
    }
  });

  it("pads the data range by about 8% on each side", () => {
    const { domain } = priceAxis(62_000, 64_500);
    expect(domain[0]).toBeCloseTo(62_000 - 200);
    expect(domain[1]).toBeCloseTo(64_500 + 200);
  });

  it("never plots below $0 for a wide range that starts near zero", () => {
    expect(priceAxis(3_000, 110_000).domain[0]).toBe(0);
  });

  it("a flat range still gets a readable domain, with distinct labels", () => {
    const { domain, ticks } = priceAxis(50_000, 50_000);
    expect(domain[1] - domain[0]).toBeGreaterThan(0);
    expect(domain[0]).toBeLessThan(50_000);
    expect(domain[1]).toBeGreaterThan(50_000);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ticks.map(formatAxisPrice)).size).toBe(ticks.length);
  });

  it("is order-independent (max,min == min,max)", () => {
    expect(priceAxis(128_000, 13_000, 5)).toEqual(priceAxis(13_000, 128_000, 5));
  });

  it("does not throw on non-finite input", () => {
    expect(() => priceAxis(NaN, 5, 5)).not.toThrow();
    expect(() => priceAxis(10, Infinity, 5)).not.toThrow();
  });
});

describe("priceAxis (Kevin item 1): the line fills the plot", () => {
  // The reported 24h case: $60,407–$61,007 on the 120px panel (an 86px plot
  // at 1.0x text fits 4 price labels; 5 is the most the plot ever takes).
  const LO = 60_407, HI = 61_007;
  for (const cap of [4, 5]) {
    it(`$60,407–$61,007 fills at least 80% of the domain, with at least two labels inside it (cap ${cap})`, () => {
      const { domain, ticks } = priceAxis(LO, HI, cap);
      const fill = (HI - LO) / (domain[1] - domain[0]);
      expect(fill, `domain ${domain[0]}–${domain[1]}`).toBeGreaterThanOrEqual(0.8);
      expect(domain[0]).toBeLessThanOrEqual(LO);
      expect(domain[1]).toBeGreaterThanOrEqual(HI);
      // Anti-vacuity: there are ticks, and every one is inside the domain.
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(cap);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(domain[0]);
        expect(t).toBeLessThanOrEqual(domain[1]);
      }
    });
  }

  it("the price chart plots priceAxis's domain and labels its ticks", () => {
    const src = readFileSync(join(__dirname, "BitcoinPriceGraph.tsx"), "utf8");
    expect(src).toContain("const { domain: yDomain, ticks: yTicks } = priceAxis(yMin, yMax, yTarget);");
    const yAxis = src.slice(src.indexOf("<YAxis"), src.indexOf("/>", src.indexOf("<YAxis")));
    expect(yAxis).toContain("domain={yDomain}");
    expect(yAxis).toContain("ticks={yTicks}");
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

describe("fittingTickCount", () => {
  it("fits as many labels as the width allows, gaps included", () => {
    // 3 × 60px labels + 2 × 20px gaps = 220px.
    expect(fittingTickCount(220, 60, 20)).toBe(3);
    expect(fittingTickCount(219, 60, 20)).toBe(2);
  });
  it("the round-1 phone plot (~270px, 24h labels ~62px) fits 3, not 6", () => {
    expect(fittingTickCount(270, 62, 20)).toBe(3);
  });
  it("never more than max on a wide plot, never fewer than min on a tiny one", () => {
    expect(fittingTickCount(2000, 60, 20)).toBe(6);
    expect(fittingTickCount(40, 60, 20)).toBe(2);
  });
  it("an unmeasured plot keeps max", () => {
    expect(fittingTickCount(0, 60, 20)).toBe(6);
    expect(fittingTickCount(300, 0, 20)).toBe(6);
    expect(fittingTickCount(NaN, 60, 20, 2, 4)).toBe(4);
  });
});

describe("xAxisBand (PR 7): the time labels clear the lowest price label", () => {
  // Recharts' geometry (recharts 3, CartesianAxis + Text): a bottom-axis label's
  // text starts tickSize + tickMargin below the axis line with its baseline a
  // cap height (0.71em) lower; a left-axis label is centred on its tick, its
  // baseline 0.355em below it, and the lowest tick IS the axis line. Font box
  // taken conservatively: 1.0em above the baseline, 0.25em below (Inter's are
  // 0.969 and 0.242).
  const ASCENT = 1.0, DESCENT = 0.25;
  // Every stop of the text-size slider (0.75–1.5, step 0.05) at the chart's
  // label size, --d-label = 0.8125rem on a 14px root.
  const STOPS = Array.from({ length: 16 }, (_, i) => +(0.75 + i * 0.05).toFixed(2));
  for (const s of STOPS) {
    const f = 0.8125 * 14 * s;
    it(`text ${s}x (${f.toFixed(2)}px labels)`, () => {
      const { tickMargin, height } = xAxisBand(f);
      const timeTop = X_TICK_SIZE + tickMargin + 0.71 * f - ASCENT * f;
      const lowestPriceBottom = 0.355 * f + DESCENT * f;
      expect(timeTop, "the first time label starts below the lowest price label, 1px clear").toBeGreaterThanOrEqual(lowestPriceBottom + 1);
      expect(height, "the band holds the time label").toBeGreaterThanOrEqual(X_TICK_SIZE + tickMargin + 0.71 * f + DESCENT * f);
    });
  }
  it("at 1.0x the band is Recharts' 30px, so the default plot keeps its height", () => {
    expect(xAxisBand(0.8125 * 14).height).toBe(30);
  });
  it("the price chart's x-axis takes the band, and the y-tick count leaves room for it", () => {
    const src = readFileSync(join(__dirname, "BitcoinPriceGraph.tsx"), "utf8");
    const xAxis = src.slice(src.indexOf("<XAxis"), src.indexOf("/>", src.indexOf("<XAxis")));
    expect(xAxis).toContain("tickMargin={xBand.tickMargin}");
    expect(xAxis).toContain("height={xBand.height}");
    expect(src).toContain("const xBand = xAxisBand(fontPx);");
    expect(src).toContain("plot.height - xBand.height");
  });
});
