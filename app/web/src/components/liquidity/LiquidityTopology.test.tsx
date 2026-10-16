// PR 9, PR9-R4 (T4): SVG text is judged by its RENDERED size, at 390px and
// 1440px. The topology draws a 150-unit cluster in a fixed-height box
// (.liq-topology-svg: width 100%, height 200px) with the default
// preserveAspectRatio "meet", so it renders at min(boxW/vbW, boxH/vbH) of its
// user units. Its viewBox was 800 wide, which made a phone width-bound (about
// 0.43x): labels of 8-10 units drew at 3.4-4.3px. At 240 wide it is
// height-bound (200/220 = 0.909x) at both widths, and 10-unit labels draw
// at 9.09px.
//
// The box widths are modelled here (390 viewport: 390 - 2x16 page padding -
// 2x8 panel-body padding - 2px border = 340; 1440: anything wider); the
// browser probe measures them. Text width is estimated at 0.65em per
// character, as DaybreakGauge.test.tsx does for the same font.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import LiquidityTopology from "./LiquidityTopology";
import type { LiquidityPeer } from "./types";
import { cssRules, declsFor } from "../../styleRules.testutil";

const FLOOR_PX = 9;
const BOX_W = { "390": 340, "1440": 1000 };
const BOX_H = parseFloat(declsFor(".liq-topology-svg", null, cssRules())["height"]);

const peer = (i: number, name: string): LiquidityPeer => ({
  pubkey: `02${String(i).padStart(64, "0")}`,
  name,
  role: "farmer",
  capacity: 1_500_000 + i,
  memberLocal: 0,
  memberRemote: 0,
  channelCount: 1,
  rolePct: 0.5,
  healthTier: "healthy",
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(peers: LiquidityPeer[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(LiquidityTopology, { peers, treasuryAlias: "Treasury", selectedPubkey: null, onSelect: () => {} }),
    );
  });
  const svg = host.querySelector("svg")!;
  const [, , vbW, vbH] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  return { svg, vbW, vbH, texts: Array.from(svg.querySelectorAll("text")) };
}

/** Rendered px of a user-unit font size in a box, under preserveAspectRatio "meet". */
const renderedPx = (fs: number, vbW: number, vbH: number, boxW: number) => fs * Math.min(boxW / vbW, BOX_H / vbH);

describe("PR9-R4: the topology's labels render at 9px or more at 390px and 1440px", () => {
  it("not vacuous: the box height is read from styles.css, and the map draws its labels", async () => {
    expect(BOX_H).toBe(200);
    const { texts } = await render([peer(1, "Alpha"), peer(2, "Bravo")]);
    expect(texts.length).toBe(1 + 2 * 2); // hub, then a name and a capacity per peer
  });

  for (const [viewport, boxW] of Object.entries(BOX_W)) {
    it(`at ${viewport}px every text renders at ${FLOOR_PX}px or more`, async () => {
      const { vbW, vbH, texts } = await render([peer(1, "Alpha"), peer(2, "Bravo"), peer(3, "Charlie")]);
      for (const t of texts) {
        const fs = Number(t.getAttribute("font-size"));
        expect(renderedPx(fs, vbW, vbH, boxW), `"${t.textContent}" at ${fs} units`).toBeGreaterThanOrEqual(FLOOR_PX);
      }
    });
  }

  it("negative control: the old 800-wide viewBox and 8/9-unit labels fail at 390px, and pass nowhere", () => {
    expect(renderedPx(8, 800, 220, BOX_W["390"])).toBeLessThan(FLOOR_PX);
    expect(renderedPx(10, 800, 220, BOX_W["390"])).toBeLessThan(FLOOR_PX);
    expect(renderedPx(9, 800, 220, BOX_W["1440"])).toBeLessThan(FLOOR_PX);
  });

  it("the narrower viewBox clips no label: the widest name, at every peer count up to 12", async () => {
    for (let n = 1; n <= 12; n++) {
      const peers = Array.from({ length: n }, (_, i) => peer(i, "Wwwwwwwwwwww")); // truncated to 9 + "…"
      const { vbW, texts } = await render(peers);
      for (const t of texts) {
        const half = ((t.textContent ?? "").length * 0.65 * Number(t.getAttribute("font-size"))) / 2;
        const x = Number(t.getAttribute("x"));
        expect(x - half, `n=${n} "${t.textContent}" left edge`).toBeGreaterThanOrEqual(0);
        expect(x + half, `n=${n} "${t.textContent}" right edge`).toBeLessThanOrEqual(vbW);
      }
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
    }
  });
});
