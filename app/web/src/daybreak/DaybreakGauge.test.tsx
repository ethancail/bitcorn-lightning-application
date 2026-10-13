// The gauge's needle must never cross its own Z number — seen live on a member
// node at Z = −0.59, where the needle ran straight through the middle of it.
//
// Both shapes are read back from the RENDERED SVG's own attributes: the needle
// from the <line>'s endpoints and stroke width, the number's box from the
// <text>'s x, y, text-anchor, dominant-baseline, rem font size and its own
// characters. Nothing here copies the gauge's geometry constants.
//
// jsdom does no layout (no getBBox), so the number's box is a CONSERVATIVE
// estimate from those attributes: the full em box vertically, and 0.65em per
// character horizontally (--mono is IBM Plex Mono, 0.6em per character). The
// rem font size is resolved across a spread of root sizes wider than the app's
// text-scale range (styles.css: 14px × 0.75…1.5), since the member chooses it.
//
// Band table: a TEST FIXTURE, not Kevin's labels.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import DaybreakGauge from "./DaybreakGauge";
import { formatZ, type Band } from "./daybreakView";

const TABLE: Band[] = [
  { lower: null, upper: -1, label: "Fixture A" },
  { lower: -1, upper: -0.25, label: "Fixture B" },
  { lower: -0.25, upper: 0.25, label: "Fixture C" },
  { lower: 0.25, upper: 1, label: "Fixture D" },
  { lower: 1, upper: null, label: "Fixture E" },
];

// [Z, the band index the Worker would stamp for it]. ±1000 sit far inside the
// open outer bands, where the needle is clamped to the arc's ends.
const CASES: Array<[string, number, number]> = [
  ["far negative clamp", -1000, 0],
  ["−0.59 (seen live)", -0.59, 1],
  ["0", 0, 2],
  ["+0.59", 0.59, 3],
  ["far positive clamp", 1000, 4],
];

const ROOT_PX = [10, 14, 16, 21, 28];

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(value: number, index: number) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(DaybreakGauge, { value, bands: { status: "available", table: TABLE, index } }));
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

type Box = { x0: number; y0: number; x1: number; y1: number };

const num = (el: Element, attr: string) => {
  const v = el.getAttribute(attr);
  if (v === null || !Number.isFinite(Number(v))) throw new Error(`<${el.tagName}> ${attr}="${v}" is not a number`);
  return Number(v);
};

function needleOf(svg: Element) {
  const lines = svg.querySelectorAll("line");
  if (lines.length !== 1) throw new Error(`expected one needle <line>, found ${lines.length}`);
  const l = lines[0];
  return { x1: num(l, "x1"), y1: num(l, "y1"), x2: num(l, "x2"), y2: num(l, "y2"), half: num(l, "stroke-width") / 2 };
}

/** The number's box in SVG user units, for a given root font size in px. */
function numberBox(t: SVGTextElement, rootPx: number): Box {
  const rem = /^([\d.]+)rem$/.exec(t.style.fontSize);
  if (!rem) throw new Error(`number font size "${t.style.fontSize}" is not rem`);
  const fs = Number(rem[1]) * rootPx;
  const x = num(t, "x");
  const y = num(t, "y");
  const w = (t.textContent ?? "").length * 0.65 * fs;
  const anchor = t.getAttribute("text-anchor") ?? "start";
  const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  const baseline = t.getAttribute("dominant-baseline") ?? "auto";
  // y is the em box's top edge for text-before-edge; for the default
  // (alphabetic) baseline the em box sits mostly above y.
  if (baseline === "text-before-edge") return { x0, x1: x0 + w, y0: y, y1: y + fs };
  if (baseline === "auto" || baseline === "alphabetic") return { x0, x1: x0 + w, y0: y - fs, y1: y + 0.3 * fs };
  throw new Error(`dominant-baseline "${baseline}" has no box rule here`);
}

/** Does segment (x1,y1)→(x2,y2) touch box b? Liang–Barsky clip. */
function segmentHitsBox(s: { x1: number; y1: number; x2: number; y2: number }, b: Box): boolean {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, s.x1 - b.x0],
    [dx, b.x1 - s.x1],
    [-dy, s.y1 - b.y0],
    [dy, b.y1 - s.y1],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

describe("the needle never crosses the Z number, for any Z", () => {
  it("anti-vacuity: the intersection test detects a crossing and a miss", () => {
    const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(segmentHitsBox({ x1: -5, y1: 5, x2: 15, y2: 5 }, box)).toBe(true);
    expect(segmentHitsBox({ x1: 5, y1: 20, x2: 5, y2: 8 }, box)).toBe(true);
    expect(segmentHitsBox({ x1: -5, y1: 11, x2: 15, y2: 11 }, box)).toBe(false);
    expect(segmentHitsBox({ x1: 20, y1: 0, x2: 30, y2: 10 }, box)).toBe(false);
  });

  for (const [name, z, index] of CASES) {
    it(`Z ${name}: the needle's segment, stroke included, misses the number's box at every root font size`, async () => {
      const el = await render(z, index);
      const svg = el.querySelector("svg")!;
      const needle = needleOf(svg);
      const t = el.querySelector('[data-testid="daybreak-gauge-value"]') as SVGTextElement;
      expect(svg.contains(t), "the number is drawn inside the gauge's SVG").toBe(true);
      for (const px of ROOT_PX) {
        const b = numberBox(t, px);
        const grown = { x0: b.x0 - needle.half, y0: b.y0 - needle.half, x1: b.x1 + needle.half, y1: b.y1 + needle.half };
        expect(segmentHitsBox(needle, grown), `root ${px}px: needle ${JSON.stringify(needle)} vs box ${JSON.stringify(b)}`).toBe(false);
      }
    });
  }

  it("anti-vacuity: at the clamps the needle lies flat along the pivot line, pointing left then right", async () => {
    const lo = needleOf((await render(-1000, 0)).querySelector("svg")!);
    expect(Math.abs(lo.y2 - lo.y1)).toBeLessThan(0.01);
    expect(lo.x2).toBeLessThan(lo.x1);
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    const hi = needleOf((await render(1000, 4)).querySelector("svg")!);
    expect(Math.abs(hi.y2 - hi.y1)).toBeLessThan(0.01);
    expect(hi.x2).toBeGreaterThan(hi.x1);
  });

  it("the number stays inside the gauge's viewBox across the app's text-scale range (14px × 0.75…1.5)", async () => {
    const el = await render(-0.59, 1);
    const svg = el.querySelector("svg")!;
    const [vx, vy, vw, vh] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    const t = el.querySelector('[data-testid="daybreak-gauge-value"]') as SVGTextElement;
    for (const px of [10.5, 14, 21]) {
      const b = numberBox(t, px);
      expect(b.x0, `root ${px}px`).toBeGreaterThanOrEqual(vx);
      expect(b.x1, `root ${px}px`).toBeLessThanOrEqual(vx + vw);
      expect(b.y0, `root ${px}px`).toBeGreaterThanOrEqual(vy);
      expect(b.y1, `root ${px}px`).toBeLessThanOrEqual(vy + vh);
    }
  });

  for (const [name, z, index] of CASES) {
    it(`Z ${name}: the number shows the Z's value and the band label shows`, async () => {
      const el = await render(z, index);
      expect(el.querySelector('[data-testid="daybreak-gauge-value"]')?.textContent).toBe(formatZ(z));
      expect(el.querySelector('[data-testid="daybreak-band-current"]')?.textContent).toBe(TABLE[index].label);
    });
  }
});
