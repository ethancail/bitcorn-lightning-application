// Kevin K4a: the price chart's y-labels follow the plot's height. They stay
// at round values, as many as the height takes with at least MIN_GAP_EM label
// sizes between neighbours.
//
// The real BitcoinPriceGraph is rendered, so this exercises the component's
// own sizing path (its plot measurement, x-axis band and priceAxis call), not
// a copy of it. jsdom has no layout: the plot's box is stubbed at the K4
// heights, and Recharts is replaced by stand-ins that hand back the props the
// component gives the y-axis. The series is the K4 24h snapshot
// ($80,809.275–$83,076.235, 300 points); only its extremes reach the y-axis,
// so the low, a middle point and the high stand in for it.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import * as fmt from "./priceChartFormat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AxisProps = { domain: [number, number]; ticks: number[]; tick: { fontSize: number } };
const { axes } = vi.hoisted(() => ({ axes: [] as AxisProps[] }));

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const None = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>,
    XAxis: None,
    Area: None,
    Tooltip: None,
    YAxis: (p: AxisProps) => {
      axes.push(p);
      return null;
    },
  };
});

import BitcoinPriceGraph from "./BitcoinPriceGraph";

// The gap K4a chose: 6.5 label sizes, 73.9px at 1.0x text. The Power Law
// chart, the reference, spaces its labels 73px apart at its densest (the 2042
// view) at 11px labels: 6.6 label sizes.
const MIN_GAP_EM = 6.5;
const FONT_PX = 0.8125 * 14; // --d-label at the 14px root (1.0x text)
const PLOT_TOP = 4; // the AreaChart's top margin
const SNAPSHOT = [80_809.275, 81_950, 83_076.235];
const T0 = 1_760_000_000;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let plotHeight = 0;
let series = SNAPSHOT;

beforeEach(() => {
  axes.length = 0;
  series = SNAPSHOT;
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("/spot")
        ? { data: { amount: "82001.68", base: "BTC", currency: "USD" } }
        : { data: { prices: series.map((p, i) => ({ price: String(p), time: String(T0 + i * 3600) })) } },
  }));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const h = this.classList.contains("price-plot") ? plotHeight : 0;
    const w = this.classList.contains("price-plot") ? 932 : 0;
    return { x: 0, y: 0, top: 0, left: 0, width: w, height: h, right: w, bottom: h, toJSON: () => ({}) } as DOMRect;
  });
  const style = document.createElement("style");
  style.id = "k4a-label";
  style.textContent = `.price-plot { font-size: ${FONT_PX}px; }`;
  document.head.appendChild(style);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.getElementById("k4a-label")?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function yAxisAt(height: number): Promise<{ ticks: number[]; spacing: number[]; fontPx: number }> {
  plotHeight = height;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<BitcoinPriceGraph />));
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  const last = axes.at(-1);
  expect(last, "the y-axis rendered").toBeDefined();
  const { domain, ticks, tick } = last!;
  // The px between neighbouring labels: the y-axis spans the plot less the
  // top margin and the x-axis band.
  const axisPx = height - PLOT_TOP - fmt.xAxisBand(tick.fontSize).height;
  const pxPer = axisPx / (domain[1] - domain[0]);
  const spacing = ticks.slice(1).map((t, i) => (t - ticks[i]) * pxPer);
  return { ticks, spacing, fontPx: tick.fontSize };
}

describe("K4a: the price labels scale with the plot's height", () => {
  it("the plot reads the 1.0x label size (so the gap below is the real one)", async () => {
    expect((await yAxisAt(480)).fontPx).toBeCloseTo(FONT_PX, 3);
  });

  it("480px (desktop): more than 3 labels, none closer than the gap", async () => {
    const { ticks, spacing } = await yAxisAt(480);
    expect(ticks.length, `labels ${ticks.join(", ")}`).toBeGreaterThan(3);
    for (const s of spacing) expect(s, `labels ${ticks.join(", ")}`).toBeGreaterThanOrEqual(MIN_GAP_EM * FONT_PX);
  });

  it("240px (phone): at least 3 labels, none closer than the gap", async () => {
    const { ticks, spacing } = await yAxisAt(240);
    expect(ticks.length, `labels ${ticks.join(", ")}`).toBeGreaterThanOrEqual(3);
    for (const s of spacing) expect(s, `labels ${ticks.join(", ")}`).toBeGreaterThanOrEqual(MIN_GAP_EM * FONT_PX);
  });

  // Beyond the snapshot. $80,200–$82,700 takes six $500 labels at 480px (K1
  // stopped at five). $80,100–$82,945 is where the count alone would crowd:
  // seven $500 labels fit a 7-label cap, but 67.6px apart.
  it("the count is the height's, not a fixed cap: six labels where six fit", async () => {
    series = [80_200, 81_500, 82_700];
    const { ticks } = await yAxisAt(480);
    expect(ticks.length, `labels ${ticks.join(", ")}`).toBe(6);
  });

  for (const [lo, hi] of [[80_100, 82_945], [80_200, 82_700], [60_407, 61_007], [13_000, 128_000], [99_000, 101_000]]) {
    for (const h of [480, 240]) {
      it(`$${lo}–$${hi} at ${h}px: at least two labels, never closer than the gap`, async () => {
        series = [lo, (lo + hi) / 2, hi];
        const { ticks, spacing } = await yAxisAt(h);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        if (ticks.length > 2) for (const s of spacing) expect(s, `labels ${ticks.join(", ")}`).toBeGreaterThanOrEqual(MIN_GAP_EM * FONT_PX);
      });
    }
  }

  it("the gap is priceChartFormat's", () => {
    expect((fmt as Record<string, unknown>).PRICE_LABEL_GAP_EM).toBe(MIN_GAP_EM);
  });
});
