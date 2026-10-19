// Kevin item 2 (rulings K2, K2a): the five chart tooltips are one shared
// ChartTooltip. The date line is --text-2; a series name is a TEXT colour,
// never its series colour, with a coloured dot as the marker; a dot only for a
// series the chart actually draws (the ratio tooltip's BTC Price and Corn Price
// are context, not lines, so they get none); the size comes from a stylesheet
// rule at the X2 label size, not an inline font-size.
//
// Each chart's tooltip is rendered with a payload shaped like the one Recharts
// passes, and the colour of a piece of text is resolved the way the browser
// would for this markup: inline style first, then the stylesheet rule for each
// of its classes, walking up to the tooltip root. jsdom does not apply
// styles.css, so the rule is read with the same helper the layout tests use.
// The property checks are soft, so one red tooltip reports every way it fails.
// That keeps the check independent of how a tooltip is built: it scored the
// per-chart copies (red) and scores the shared one the same way.

import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssRules, declsFor } from "../styleRules.testutil";
import { PriceTooltip } from "./BitcoinPriceGraph";
import { PowerLawTooltip } from "./PowerLawChart";
import { MATooltip } from "./MovingAveragesChart";
import { CBTooltip } from "./CornBitcoinChart";
import { CMATooltip } from "./CornMovingAveragesChart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RULES = cssRules();
const TEXT_COLOURS = ["var(--text)", "var(--text-2)"];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  const box = host.firstElementChild as HTMLElement | null;
  expect(box, "the tooltip rendered").not.toBeNull();
  return box!;
}

function ownColour(el: HTMLElement): string | undefined {
  if (el.style.color) return el.style.color;
  for (const c of Array.from(el.classList)) {
    const d = declsFor("." + c, null, RULES);
    if (d.color) return d.color;
  }
  return undefined;
}

function colourOf(el: HTMLElement, box: HTMLElement): string | undefined {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    const c = ownColour(e);
    if (c) return c;
    if (e === box) break;
  }
  return undefined;
}

/** The innermost element whose whole text is `text`. */
function textEl(box: HTMLElement, text: string): HTMLElement {
  const all = [box, ...Array.from(box.querySelectorAll<HTMLElement>("*"))].filter((e) => e.textContent?.trim() === text);
  const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
  expect(inner.length, `exactly one element reads "${text}"; got: ${box.textContent}`).toBe(1);
  return inner[0];
}

/** A text-less coloured marker inside the label or just before it. */
function dotOf(label: HTMLElement): string | undefined {
  const near = [...Array.from(label.querySelectorAll<HTMLElement>("*")), label.previousElementSibling as HTMLElement | null];
  for (const e of near) {
    if (!e || e.textContent?.trim()) continue;
    const bg = e.style.background || e.style.backgroundColor;
    if (bg) return bg;
  }
  return undefined;
}

function expectSharedSizing(box: HTMLElement) {
  expect.soft(box.style.fontSize, "no inline font-size on the tooltip").toBe("");
  const sized = Array.from(box.classList).map((c) => declsFor("." + c, null, RULES)["font-size"]);
  expect.soft(sized, `a class on the tooltip (${box.className || "none"}) sets the size`).toContain("var(--d-label)");
}

function expectDate(box: HTMLElement, date: string) {
  expect.soft(colourOf(textEl(box, date), box), `date "${date}"`).toBe("var(--text-2)");
}

function expectSeries(box: HTMLElement, name: string, seriesColour: string | null) {
  const label = textEl(box, name);
  const c = colourOf(label, box);
  expect.soft(TEXT_COLOURS, `"${name}" is in a text colour (got ${c})`).toContain(c);
  if (seriesColour) {
    expect.soft(c, `"${name}" is not in its series colour`).not.toBe(seriesColour);
    expect.soft(dotOf(label), `"${name}" is marked by a ${seriesColour} dot`).toBe(seriesColour);
  } else {
    expect.soft(dotOf(label), `"${name}" is not a drawn line, so it has no dot`).toBeUndefined();
  }
}

const POINT_DATE = "2026-10-01";
const LONG_DATE = "October 1, 2026";

describe("chart tooltips (Kevin item 2)", () => {
  it("Bitcoin Price: date in --text-2, price shown, shared sizing", () => {
    const time = Math.floor(Date.UTC(2026, 9, 1, 12) / 1000);
    const box = render(
      <PriceTooltip active period="30d" payload={[{ payload: { time, price: 60_407, label: "Oct 1" } }]} />,
    );
    expect(box.textContent).toContain("$60,407.00");
    expectDate(box, "Oct 1");
    expectSharedSizing(box);
  });

  it("Power Law: every band named in a text colour with its line's dot", () => {
    const point = { date: POINT_DATE };
    const series: Array<[string, string, string]> = [
      ["btc", "BTC Price", "var(--chart-amber)"],
      ["p97_5", "97.5th Percentile", "var(--chart-red)"],
      ["trend", "Power Law Trend", "var(--chart-green)"],
      ["p2_5", "2.5th Percentile", "var(--chart-indigo)"],
    ];
    const box = render(
      <PowerLawTooltip
        active
        payload={series.map(([dataKey, , color], i) => ({ dataKey, color, value: 60_000 + i, payload: point as never }))}
      />,
    );
    expectDate(box, LONG_DATE);
    for (const [, name, colour] of series) expectSeries(box, name, colour);
    expect(box.textContent).toContain("$60,000.00");
    expectSharedSizing(box);
  });

  it("Moving Averages: every average named in a text colour with its line's dot", () => {
    const point = { date: POINT_DATE };
    const series: Array<[string, string, string]> = [
      ["btc", "BTC Price", "var(--chart-amber)"],
      ["ma50", "50-day MA", "var(--chart-cyan)"],
      ["ma100", "100-day MA", "var(--chart-violet)"],
      ["ma200", "200-day MA", "var(--chart-green)"],
    ];
    const box = render(
      <MATooltip
        active
        payload={series.map(([dataKey, , color], i) => ({ dataKey, color, value: 60_000 + i, payload: point as never }))}
      />,
    );
    expectDate(box, LONG_DATE);
    for (const [, name, colour] of series) expectSeries(box, name, colour);
    expect(box.textContent).toContain("$60,003.00");
    expectSharedSizing(box);
  });

  it("Corn Moving Averages: every average named in a text colour with its line's dot", () => {
    const point = { date: POINT_DATE };
    const series: Array<[string, string, string]> = [
      ["corn", "Corn Price", "var(--chart-green)"],
      ["ma50", "50-day MA", "var(--chart-cyan)"],
      ["ma100", "100-day MA", "var(--chart-violet)"],
      ["ma200", "200-day MA", "var(--chart-amber)"],
    ];
    const box = render(
      <CMATooltip
        active
        payload={series.map(([dataKey, , color], i) => ({ dataKey, color, value: 4.12 + i, payload: point as never }))}
      />,
    );
    expectDate(box, LONG_DATE);
    for (const [, name, colour] of series) expectSeries(box, name, colour);
    expect(box.textContent).toContain("$4.12/bu");
    expectSharedSizing(box);
  });

  it("Corn–Bitcoin ratio (K2a): only the drawn ratio line gets a dot", () => {
    const point = { date: POINT_DATE, ts: 0, ratio: 14_662, btcPrice: 60_407, cornPrice: 4.12 };
    const box = render(
      <CBTooltip active payload={[{ dataKey: "ratio", value: point.ratio, color: "var(--chart-amber)", payload: point }]} />,
    );
    expectDate(box, LONG_DATE);
    expectSeries(box, "BTC Price", null);
    expectSeries(box, "Corn Price", null);
    expectSeries(box, "Bushels / BTC", "var(--chart-amber)");
    expect(box.textContent).toContain("$60,407.00");
    expect(box.textContent).toContain("$4.12/bu");
    expect(box.textContent).toContain("14,662");
    expectSharedSizing(box);
  });
});

describe("the shared tooltip", () => {
  it("is sized at the X2 label size (--d-label = 0.8125rem)", () => {
    expect(declsFor(":root", null, RULES)["--d-label"]).toBe("0.8125rem");
  });

  const CHARTS = ["BitcoinPriceGraph", "PowerLawChart", "MovingAveragesChart", "CornBitcoinChart", "CornMovingAveragesChart"];
  for (const chart of CHARTS) {
    it(`${chart} renders ChartTooltip, not its own copy`, () => {
      const src = readFileSync(join(__dirname, `${chart}.tsx`), "utf8");
      expect(src).toContain('from "./ChartTooltip"');
      expect(src).toContain("<ChartTooltip");
      // The per-chart copies' box and size, inline.
      expect(src).not.toMatch(/fontSize: "0\.75rem"/);
      expect(src).not.toMatch(/padding: "(10px 14px|8px 12px)"/);
    });
  }
});
