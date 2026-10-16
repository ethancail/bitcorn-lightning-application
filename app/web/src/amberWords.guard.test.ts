// Colour round (CR-1, variant b as picked): amber is a mark — a bar, a dot, a
// fill, a rule or a glyph marker — and never a word. A static scan: every CSS
// `color` that resolves to amber must belong to a glyph marker, and every
// inline amber `color` in a component must sit on a lone glyph. Daybreak's
// own files are exempt until Daybreak adapts after N1 (its follow-up work).
// capacityText.guard.test.tsx keeps checking the rendered capacity words.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cssRules, type CssRule } from "./styleRules.testutil";

const AMBER_COLOUR = /var\(--amber(-dim)?\)|rgba\(\s*(245,\s*158,\s*11|217,\s*119,\s*6)\b/;

/** Glyph markers: a symbol, not a word, so amber may colour it (a mark, 3:1). */
const GLYPH_SELECTORS = new Set([
  ".panel.ops .panel-title .icon",
  ".sub-panel-glyph",
  ".sub-timeline-marker-amber",
  ".sub-alert-amber .sub-alert-icon",
  ".sub-alert-dashed .sub-alert-icon",
  ".stablecoin-extlink-icon",
]);

/** Daybreak's files: not this arc's to edit (F11). N1 asks Daybreak to adapt. */
const DAYBREAK_FILES = new Set(["pages/Daybreak.tsx", "daybreak/DaybreakGauge.tsx", "daybreak/daybreakView.ts"]);

/** Colour data whose amber only ever paints marks: the commodity tickers'
 *  `color` sets their icon and border (CommodityPricesPanel.tsx:149-150);
 *  their labels are --text-2. A line here is a data value, not a style. */
const MARK_DATA: Record<string, RegExp> = {
  "components/CommodityPricesPanel.tsx": /^\s*color: "var\(--amber(-dim)?\)",$/,
};

export function cssOffenders(rules: CssRule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const c = r.decls["color"];
    if (!c || !AMBER_COLOUR.test(c)) continue;
    for (const s of r.selectors) if (!GLYPH_SELECTORS.has(s)) out.push(`styles.css:${r.line} ${s} { color: ${c} }`);
  }
  return out;
}

/** An inline `color:` that can be amber, on a line whose element is not a lone glyph. */
export function tsxOffenders(file: string, src: string): string[] {
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (!/color:\s*[^,}]*var\(--amber(-dim)?\)/.test(line)) return;
    if (/>\s*[✓◈⚠↗●◆]\s*</.test(line)) return;
    if (MARK_DATA[file]?.test(line)) return;
    out.push(`${file}:${i + 1} ${line.trim()}`);
  });
  return out;
}

function sources(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p, root);
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) && !n.endsWith(".testutil.ts") ? [relative(root, p)] : [];
  });
}

describe("amber is a mark, never a word", () => {
  it("no CSS rule colours a word amber", () => {
    expect(cssOffenders(cssRules())).toEqual([]);
  });

  it("no component colours a word amber (Daybreak's files excepted)", () => {
    const offenders = sources(__dirname)
      .filter((f) => !DAYBREAK_FILES.has(f))
      .flatMap((f) => tsxOffenders(f, readFileSync(join(__dirname, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the exemption names Daybreak's files only, and each still exists", () => {
    for (const f of DAYBREAK_FILES) {
      expect(f.startsWith("daybreak/") || f === "pages/Daybreak.tsx").toBe(true);
      expect(statSync(join(__dirname, f)).isFile()).toBe(true);
    }
  });
});

describe("negative controls: the scan sees an amber word, and passes a glyph", () => {
  const rule = (selectors: string[], color: string): CssRule => ({ media: null, container: null, selectors, decls: { color }, line: 1 });

  it("flags a word rule in amber, and in light amber's old rgba", () => {
    expect(cssOffenders([rule([".badge-amber"], "var(--amber)")])).toHaveLength(1);
    expect(cssOffenders([rule([".form-label"], "rgba(217,119,6,0.6)")])).toHaveLength(1);
    expect(cssOffenders([rule([".x"], "var(--amber-dim)")])).toHaveLength(1);
  });

  it("passes a glyph marker and a word in ink", () => {
    expect(cssOffenders([rule([".sub-timeline-marker-amber"], "var(--amber)")])).toEqual([]);
    expect(cssOffenders([rule([".badge-amber"], "var(--text)")])).toEqual([]);
  });

  it("flags an inline amber word, and passes an inline amber glyph", () => {
    expect(tsxOffenders("X.tsx", `<span style={{ color: "var(--amber)" }}>Closing…</span>`)).toHaveLength(1);
    expect(tsxOffenders("X.tsx", `color: ok ? "var(--green)" : "var(--amber)" }}>`)).toHaveLength(1);
    expect(tsxOffenders("X.tsx", `<span aria-hidden style={{ color: "var(--amber)" }}>⚠</span> Refresh failed`)).toEqual([]);
  });

  it("would catch Daybreak's amber words if the exemption were lifted", () => {
    const offenders = [...DAYBREAK_FILES].flatMap((f) => tsxOffenders(f, readFileSync(join(__dirname, f), "utf8")));
    expect(offenders.length).toBeGreaterThan(0);
  });
});
