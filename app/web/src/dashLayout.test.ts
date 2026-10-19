// PR 6: the dashboards' layout rules, read from styles.css (jsdom does not
// evaluate @media). The browser captures are the evidence of what renders;
// these pin the rules that make it so.
//   X1   — a headline number never splits; on a phone the numbers stack.
//   J9   — on a phone, info notices go below the headline (J9a: the
//          lapse banners that refuse payments or close the channel stay on top).
//   CHART — the price tile takes the headline's place in that order.
//   D3   — a negative headline number is --text, never red.
//   X5a  — the price plot is 480px tall on desktop, 240px on a phone (K4).

import { describe, expect, it } from "vitest";
import { cssRules, declsFor, specificity, type CssRule } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";
const RULES = cssRules();

/** The price plot's height where `media` applies (null: desktop), as the
 *  cascade resolves it: of the rules that apply there, the most specific wins,
 *  then the later; a var() is read from the :root tokens that apply there.
 *  jsdom evaluates no @media, so this reads the rules instead. */
function plotHeight(media: string | null): string | undefined {
  const applies = (r: CssRule) => r.media === null || r.media === media;
  let win: { spec: number; line: number; value: string } | undefined;
  for (const r of RULES) {
    if (!applies(r) || r.decls.height === undefined) continue;
    for (const s of r.selectors.filter((s) => s.includes("price-plot"))) {
      const spec = specificity(s);
      if (!win || spec > win.spec || (spec === win.spec && r.line > win.line)) win = { spec, line: r.line, value: r.decls.height };
    }
  }
  const tokens: Record<string, string> = {};
  for (const r of RULES) if (applies(r) && r.selectors.includes(":root")) Object.assign(tokens, r.decls);
  return win?.value.replace(/^var\((--[\w-]+)\)$/, (_, t: string) => tokens[t]);
}

describe("the dashboard column", () => {
  it("is one flex column with the density gap between sections", () => {
    expect(declsFor(".dash")).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      gap: "var(--d-gap)",
    });
  });

  it("the name notice is a section of that column, so the gap clears it from the h1", () => {
    // The notice used to sit flush against "My Dashboard" (PR 5's capture):
    // .alert has no margin, and the page header had none above it.
    expect(declsFor(".dash-notices")).toMatchObject({ display: "flex", "flex-direction": "column" });
    expect(declsFor(".dash-header")).toMatchObject({ display: "flex", "flex-direction": "column" });
  });

  it(".page-header keeps its own layout: the dashboards' header rule is scoped", () => {
    // .page-header is app-wide (Stablecoin.tsx, ValuationInput.tsx's row header).
    for (const r of RULES) {
      if (r.selectors.includes(".page-header")) expect(r.decls["flex-direction"], `line ${r.line}`).toBeUndefined();
    }
  });
});

describe("X1: a headline number never splits", () => {
  it("the number is its own nowrap box", () => {
    expect(declsFor(".hl-num")["white-space"]).toBe("nowrap");
  });

  it("nothing on the value adds a break opportunity inside it", () => {
    const v = declsFor(".hl-value");
    expect(v["overflow-wrap"]).toBeUndefined();
    expect(v["word-break"]).toBeUndefined();
    expect(v["white-space"]).toBeUndefined();
  });

  it("the unit is an atomic inline, so it drops below the number instead", () => {
    expect(declsFor(".hl-value .unit").display).toBe("inline-block");
  });

  it("nothing shrinks to fit: sizes are the density tokens, no clamp or vw", () => {
    expect(declsFor(".hl-value")["font-size"]).toBe("var(--d-hl2)");
    expect(declsFor(".hl-1 .hl-value")["font-size"]).toBe("var(--d-hl1)");
  });

  it("on a phone the headline numbers stack into one column", () => {
    expect(declsFor(".dash > .headline", PHONE)["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });
});

describe("J9 / J9a: the phone order", () => {
  const order = (sel: string) => Number(declsFor(sel, PHONE).order);

  it("top notices, then the header, then the headline with the chart, then info notices, then the rest", () => {
    expect(order(".dash > .dash-notices-top")).toBeLessThan(order(".dash > .dash-header"));
    expect(order(".dash > .dash-header")).toBeLessThan(order(".dash > .headline"));
    expect(order(".dash > .headline")).toBeLessThan(order(".dash > .dash-notices-info"));
    expect(order(".dash > .dash-notices-info")).toBeLessThan(order(".dash > *"));
  });

  it("CHART: the price tile and the headline's status line keep the headline's place", () => {
    expect(order(".dash > .price-tile")).toBe(order(".dash > .headline"));
    expect(order(".dash > .headline-status")).toBe(order(".dash > .headline"));
  });

  it("desktop keeps the source order: no order rule outside the phone query", () => {
    for (const r of RULES) {
      if (r.media === null && r.selectors.some((s) => s.startsWith(".dash"))) expect(r.decls.order, r.selectors.join()).toBeUndefined();
    }
  });
});

describe("D3: no red on numbers", () => {
  it("a negative headline number and a negative figure are --text", () => {
    expect(declsFor(".hl-value.negative").color).toBe("var(--text)");
    expect(declsFor(".figure-value.negative").color).toBe("var(--text)");
  });
});

describe("the detail grid", () => {
  it("--d-cols columns on desktop, one on a phone", () => {
    expect(declsFor(".dash-grid")["grid-template-columns"]).toBe("repeat(var(--d-cols), minmax(0, 1fr))");
    expect(declsFor(".dash-grid", PHONE)["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });
});

describe("X5 / X5a: the price chart", () => {
  it("the plot reads the density chart height, and its axis labels read --d-label", () => {
    expect(declsFor(".price-plot")).toMatchObject({ height: "var(--d-chart-h)", "font-size": "var(--d-label)" });
  });

  it("X5a (K4): the plot is 480px tall on desktop and 240px on a phone", () => {
    expect({ desktop: plotHeight(null), phone: plotHeight(PHONE) }).toEqual({ desktop: "480px", phone: "240px" });
  });

  it("X5a (K4): those are the only two rules that size the plot", () => {
    const sizing = RULES.filter((r) => r.decls.height !== undefined && r.selectors.some((s) => s.includes("price-plot")));
    expect(sizing.map((r) => [r.media, r.decls.height])).toEqual([
      [PHONE, "var(--d-chart-h-ph)"],
      [null, "var(--d-chart-h)"],
    ]);
  });

  it("the price supports: sized by --d-price, below the headline's --d-hl2", () => {
    expect(declsFor(".price-spot")["font-size"]).toBe("var(--d-price)");
  });
});
