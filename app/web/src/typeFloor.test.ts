// PR 9 (T1, T3): no font size under 9px at text scale 1.0, against the 14px
// root (P5; J1's floor), across app/web/src — styles.css and every inline
// size in .ts/.tsx. The criterion is STRICT: 8.99px counts, 9px does not
// (the first spec, §3 :137). A px size does not follow the text-size
// setting, so it is read as written; a rem size is read at text 1.0.
//
// SVG text inside a scaled viewBox is judged by its RENDERED size (PR9-R4);
// that is LiquidityTopology.test.tsx's job. This scan reads the nominal size
// of SVG text too, which is the stricter reading for every SVG except one
// that scales up: Daybreak's gauge, the one allowlisted line below.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, type CssRule } from "./styleRules.testutil";

const FLOOR_PX = 9;
const ROOT_PX = 14;

// Listed for its owner, not edited (P5; PR9-R4): the gauge's boundary labels.
// Its viewBox is 240 wide drawn up to 420px, so they render larger than
// their nominal 7.9px. Each entry is file + the exact source text.
const ALLOWED: Array<{ file: string; text: string }> = [
  { file: "daybreak/DaybreakGauge.tsx", text: `style={{ fontSize: "0.5625rem", fontFamily: "var(--mono)" }}` },
];

type Hit = { where: string; size: string; px: number };

function toPx(value: string, unit: string): number {
  const v = Number(value);
  return unit === "rem" || unit === "em" ? v * ROOT_PX : v;
}

/** Every font size in CSS rules, as hits (under the floor or not). */
function cssSizes(rules: CssRule[], file: string): Hit[] {
  const out: Hit[] = [];
  for (const r of rules) {
    for (const [prop, val] of Object.entries(r.decls)) {
      const m =
        prop === "font-size"
          ? /^([\d.]+)(rem|em|px)$/.exec(val)
          : prop === "font"
            ? /(?:^|\s)([\d.]+)(rem|em|px)(?:\/|\s)/.exec(val)
            : null;
      if (m) out.push({ where: `${file}:${r.line} ${r.selectors.join(", ")}`, size: `${m[1]}${m[2]}`, px: toPx(m[1], m[2]) });
    }
  }
  return out;
}

const INLINE = [
  // fontSize: "0.625rem" | fontSize: '9px' | fontSize="9"
  /fontSize\s*[:=]\s*\{?\s*["'`]([\d.]+)(rem|em|px)?["'`]/g,
  // fontSize: 9 | fontSize={9}  (a number is px)
  /fontSize\s*[:=]\s*\{?\s*([\d.]+)(?![\d.]*\s*(?:rem|em|px|%|["'`]))/g,
  // font-size: 0.6rem inside a template string
  /font-size\s*:\s*([\d.]+)(rem|em|px)/g,
];

/** Every inline font size in one source file, as hits. */
function inlineSizes(src: string, file: string): Hit[] {
  const out: Hit[] = [];
  src.split("\n").forEach((line, i) => {
    for (const re of INLINE) {
      for (const m of line.matchAll(re)) {
        const unit = m[2] ?? "px";
        out.push({ where: `${file}:${i + 1} ${line.trim()}`, size: `${m[1]}${unit}`, px: toPx(m[1], unit) });
      }
    }
  });
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test(util)?\.|\.testutil\./.test(name)) out.push(p);
  }
  return out;
}

const allowed = (h: Hit) => ALLOWED.some((a) => h.where.startsWith(`${a.file}:`) && h.where.includes(a.text));

function allSizes(): Hit[] {
  const hits: Hit[] = [];
  for (const p of sources(__dirname)) {
    const file = relative(__dirname, p);
    hits.push(...(p.endsWith(".css") ? cssSizes(cssRules(p), file) : inlineSizes(readFileSync(p, "utf8"), file)));
  }
  return hits;
}

describe("T1: no font size under 9px at text 1.0", () => {
  const hits = allSizes();

  it("not vacuous: the scan reads styles.css and the inline sizes, hundreds of each", () => {
    expect(hits.filter((h) => h.where.startsWith("styles.css:")).length).toBeGreaterThanOrEqual(150);
    expect(hits.filter((h) => !h.where.startsWith("styles.css:")).length).toBeGreaterThanOrEqual(400);
  });

  it("every size is 9px or more, except the listed owner's line", () => {
    const under = hits.filter((h) => h.px < FLOOR_PX && !allowed(h)).map((h) => `${h.where} — ${h.size} = ${h.px.toFixed(2)}px`);
    expect(under).toEqual([]);
  });

  it("negative control: the criterion is strict, in CSS and inline, both ways", () => {
    const css = cssSizes(
      [
        { media: null, container: null, selectors: [".a"], decls: { "font-size": "8.99px" }, line: 1 },
        { media: null, container: null, selectors: [".b"], decls: { "font-size": "9px" }, line: 2 },
        { media: null, container: null, selectors: [".c"], decls: { "font-size": "0.64rem" }, line: 3 },
        { media: null, container: null, selectors: [".d"], decls: { "font-size": "0.6428572rem" }, line: 4 },
        { media: null, container: null, selectors: [".e"], decls: { font: "600 0.625rem/1.2 var(--font)" }, line: 5 },
      ],
      "planted.css",
    ).filter((h) => h.px < FLOOR_PX).map((h) => h.size);
    expect(css).toEqual(["8.99px", "0.64rem", "0.625rem"]);

    const inline = inlineSizes(
      [
        `<div style={{ fontSize: "8.99px" }} />`,
        `<div style={{ fontSize: "9px" }} />`,
        `<div style={{ fontSize: 8.99 }} />`,
        `<div style={{ fontSize: 9 }} />`,
        `<text fontSize={8} />`,
        `<text fontSize={9} />`,
        `<text fontSize="8" />`,
        "const s = `font-size: 0.6rem;`;",
        `<div style={{ fontSize: "0.6875rem" }} />`,
      ].join("\n"),
      "planted.tsx",
    ).filter((h) => h.px < FLOOR_PX).map((h) => h.size);
    expect(inline).toEqual(["8.99px", "8.99px", "8px", "8px", "0.6rem"]);
  });
});

describe("T3: the owner's list stays true", () => {
  it("each listed line is still in its file, and still under the floor (or it comes off the list)", () => {
    for (const a of ALLOWED) {
      const src = readFileSync(join(__dirname, a.file), "utf8");
      expect(src.includes(a.text), `${a.file} no longer has: ${a.text}`).toBe(true);
      const under = inlineSizes(a.text, a.file).filter((h) => h.px < FLOOR_PX);
      expect(under.length, `${a.file}'s listed line is no longer under 9px — remove it from ALLOWED`).toBe(1);
    }
  });

  it("negative control: a stale entry is caught, and the list cannot hide a different line", () => {
    const stale = { file: "daybreak/DaybreakGauge.tsx", text: `style={{ fontSize: "0.5rem" }}` };
    expect(readFileSync(join(__dirname, stale.file), "utf8").includes(stale.text)).toBe(false);
    const other: Hit = { where: `daybreak/DaybreakGauge.tsx:1 <text style={{ fontSize: "0.5rem" }} />`, size: "0.5rem", px: 7 };
    expect(allowed(other)).toBe(false);
  });
});
