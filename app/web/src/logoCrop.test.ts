// Kevin item 5 (ruling K3): the logo's viewBox is cropped to the artwork.
//
// The Inkscape export kept its 2560×800 page, and the drawing sits in the
// middle of it: at the topbar's 22px height the letters were about 11px tall.
// Both assets are cropped identically, with a few units of margin so the
// antialiased edge isn't clipped. The <svg>'s width/height carry the cropped
// aspect too — an <img> at `height: 22px; width: auto` takes its ratio from
// them, so a viewBox crop alone would only letterbox the artwork.
//
// ARTWORK is the drawing's bounds in viewBox units, measured in Chromium with
// svg.getBBox() on each asset inlined in a page (and again from every path's
// getBBox() through its CTM; both gave the same box, for both assets). It is
// the drawing, not the crop, so it stays valid as long as the paths and their
// two transforms are unchanged — the last test pins the transforms, and
// logoTheme.test.ts pins the paths as identical across the two assets.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const ASSETS = { dark: read("assets/bitcorn-logo.svg"), light: read("assets/bitcorn-logo-light.svg") };

const ARTWORK = { x0: 255.4, y0: 195.56, x1: 2291.27, y1: 604.44 };

function svgTag(svg: string) {
  const tag = svg.match(/<svg\b[^>]*>/)?.[0];
  expect(tag, "an <svg> element").toBeTruthy();
  const attr = (name: string) => tag!.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const vb = attr("viewBox")!.trim().split(/[\s,]+/).map(Number);
  expect(vb).toHaveLength(4);
  return { vb: { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }, width: Number(attr("width")), height: Number(attr("height")) };
}

describe("K3 logo crop", () => {
  it("both assets have the same viewBox and size", () => {
    expect(svgTag(ASSETS.light)).toEqual(svgTag(ASSETS.dark));
  });

  for (const [name, svg] of Object.entries(ASSETS)) {
    it(`${name}: the artwork fills most of the viewBox`, () => {
      const { vb } = svgTag(svg);
      const artH = ARTWORK.y1 - ARTWORK.y0;
      const artW = ARTWORK.x1 - ARTWORK.x0;
      expect(artH / vb.h, `artwork is ${((artH / vb.h) * 100).toFixed(1)}% of the viewBox height`).toBeGreaterThanOrEqual(0.9);
      expect(artW / vb.w, `artwork is ${((artW / vb.w) * 100).toFixed(1)}% of the viewBox width`).toBeGreaterThanOrEqual(0.9);
    });

    it(`${name}: nothing is clipped — at least 2 units of margin on every side`, () => {
      const { vb } = svgTag(svg);
      expect(ARTWORK.x0 - vb.x).toBeGreaterThanOrEqual(2);
      expect(ARTWORK.y0 - vb.y).toBeGreaterThanOrEqual(2);
      expect(vb.x + vb.w - ARTWORK.x1).toBeGreaterThanOrEqual(2);
      expect(vb.y + vb.h - ARTWORK.y1).toBeGreaterThanOrEqual(2);
    });

    it(`${name}: width/height carry the viewBox's aspect, so the <img> is the cropped shape`, () => {
      const { vb, width, height } = svgTag(svg);
      expect(width / height).toBeCloseTo(vb.w / vb.h, 3);
    });

    it(`${name}: the drawing itself is untouched (the transforms ARTWORK was measured under)`, () => {
      expect(svg).toContain('transform="matrix(1.3333333,0,0,-1.3333333,0,800)"');
      expect(svg).toContain('transform="scale(0.1)"');
    });
  }
});
