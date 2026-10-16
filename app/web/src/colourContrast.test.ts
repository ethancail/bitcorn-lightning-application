// Colour round (tranche 2): every token pairing at its ruled ratio, in both
// themes, computed from styles.css (WCAG 2.x relative luminance; alpha
// composited onto the surface it sits on). Words 4.5:1; marks, control
// boundaries and the focus ring 3:1 (WCAG 1.4.11). Amber is a mark only.
// The browser captures are the evidence of what renders; this is the
// arithmetic, and each check has a negative control below that plants the
// old value and must fail for the named pairing.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cssRules, type CssRule } from "./styleRules.testutil";

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
type Theme = "dark" | "light";
type Tokens = Record<string, string>;

const SURFACES = ["--bg", "--bg-1", "--bg-2", "--bg-3"];

function themeTokens(rules: CssRule[], theme: Theme): Tokens {
  const top = rules.filter((r) => r.media === null && r.container === null);
  const out: Tokens = {};
  for (const r of top.filter((r) => r.selectors.includes(":root"))) Object.assign(out, r.decls);
  if (theme === "light") for (const r of top.filter((r) => r.selectors.includes('[data-theme="light"]'))) Object.assign(out, r.decls);
  return out;
}

/** A rule's declaration, the light-theme override first in the light theme. */
function decl(rules: CssRule[], selector: string, prop: string, theme: Theme): string {
  const top = rules.filter((r) => r.media === null && r.container === null);
  if (theme === "light") {
    const o = top.filter((r) => r.selectors.includes(`[data-theme="light"] ${selector}`) && r.decls[prop]);
    if (o.length) return o[o.length - 1].decls[prop].replace("!important", "").trim();
  }
  const m = top.filter((r) => r.selectors.includes(selector) && r.decls[prop]);
  if (!m.length) throw new Error(`no ${prop} on ${selector}`);
  return m[m.length - 1].decls[prop].replace("!important", "").trim();
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")") depth--;
    else if (s[k] === "," && depth === 0) { out.push(s.slice(start, k).trim()); start = k + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** Resolve a colour value: var(), #hex, rgb(a), color-mix(in srgb, …). */
function resolve(v: string, T: Tokens, depth = 0): Rgba {
  if (depth > 12) throw new Error(`var cycle at ${v}`);
  v = v.trim();
  let m = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (m) {
    if (!(m[1] in T)) throw new Error(`undefined token ${m[1]}`);
    return resolve(T[m[1]], T, depth + 1);
  }
  if (v.startsWith("#")) {
    const h = v.slice(1);
    const x = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), 1];
  }
  m = v.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(",").map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  m = v.match(/^color-mix\(in srgb,(.*)\)$/);
  if (m) {
    const [a, b] = splitTop(m[1]);
    const pct = (s: string) => { const q = s.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/); return q ? { c: q[1], w: Number(q[2]) / 100 } : { c: s, w: NaN }; };
    const A = pct(a), B = pct(b);
    const wa = !isNaN(A.w) ? A.w : !isNaN(B.w) ? 1 - B.w : 0.5;
    if (B.c === "transparent") { const c = resolve(A.c, T, depth + 1); return [c[0], c[1], c[2], c[3] * wa]; }
    const ca = resolve(A.c, T, depth + 1), cb = resolve(B.c, T, depth + 1);
    return [0, 1, 2].map((i) => Math.round(ca[i] * wa + cb[i] * (1 - wa))).concat(1) as Rgba;
  }
  throw new Error(`unparsed colour: ${v}`);
}

const over = (fg: Rgba, bg: Rgb): Rgb => [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3]))) as Rgb;
function lum([r, g, b]: Rgb): number {
  const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const hexes = (src: string) => [...new Set(src.match(/#[0-9a-fA-F]{6}\b/g) ?? [])];

type Pairing = { name: string; ratio: number; need: number };

/** Every ruled pairing in both themes, computed from the stylesheet at `file`. */
export function pairings(file = join(__dirname, "styles.css")): Pairing[] {
  const rules = cssRules(file);
  const out: Pairing[] = [];
  const add = (name: string, fg: Rgb, bg: Rgb, need: number) => out.push({ name, ratio: ratio(fg, bg), need });
  for (const theme of ["dark", "light"] as Theme[]) {
    const T = themeTokens(rules, theme);
    const S = Object.fromEntries(SURFACES.map((s) => [s, over(resolve(`var(${s})`, T), [255, 255, 255])])) as Record<string, Rgb>;
    const tok = (t: string) => resolve(`var(${t})`, T);
    const solid = (t: string) => over(tok(t), S["--bg-1"]);
    for (const s of SURFACES) {
      for (const t of ["--text", "--text-2", "--text-3"]) add(`${theme} ${t} as text on ${s}`, solid(t), S[s], 4.5);
      // State colours that are words; amber is not one of them.
      for (const t of ["--red", "--green", "--yellow", "--blue", "--orange", "--purple"]) add(`${theme} ${t} as text on ${s}`, solid(t), S[s], 4.5);
      for (const t of ["--red", "--green", "--amber", "--amber-dim", "--yellow", "--blue", "--orange", "--purple", "--text-3"])
        add(`${theme} ${t} as a mark on ${s}`, solid(t), S[s], 3);
      add(`${theme} --focus-ring on ${s}`, solid("--focus-ring"), S[s], 3);
      if (s !== "--bg") add(`${theme} --border-control on ${s}`, solid("--border-control"), S[s], 3);
    }
    for (const b of ["green", "red", "amber", "blue", "orange", "muted", "caution"]) {
      const fill = resolve(decl(rules, `.badge-${b}`, "background", theme), T);
      const word = resolve(decl(rules, `.badge-${b}`, "color", theme), T);
      for (const s of ["--bg", "--bg-1", "--bg-3"]) {
        const f = over(fill, S[s]);
        add(`${theme} .badge-${b} word on its fill over ${s}`, over(word, f), f, 4.5);
      }
    }
    for (const b of ["caution", "amber"]) {
      const f = over(resolve(decl(rules, `.badge-${b}`, "background", theme), T), S["--bg-3"]);
      add(`${theme} .badge-${b} dot on its fill over --bg-3`, over(resolve(decl(rules, `.badge-${b}::before`, "background", theme), T), f), f, 3);
    }
    for (const a of ["critical", "warning", "info", "healthy", "orange"]) {
      const f = over(resolve(decl(rules, `.alert.${a}`, "background", theme), T), S["--bg-1"]);
      add(`${theme} .alert.${a} word`, over(resolve(decl(rules, `.alert.${a}`, "color", theme), T), f), f, 4.5);
    }
    for (const p of ["emerald", "blue", "gray-pulsing", "muted-amber", "amber", "orange", "red", "dim-red"]) {
      const f = over(resolve(decl(rules, `.sub-pill-${p}`, "background", theme), T), S["--bg-1"]);
      add(`${theme} .sub-pill-${p} word`, over(resolve(decl(rules, `.sub-pill-${p}`, "color", theme), T), f), f, 4.5);
    }
    for (const p of ["amber", "orange", "red", "dim-red", "emerald"]) {
      const f = over(resolve(decl(rules, `.sub-alert-${p}`, "background", theme), T), S["--bg-1"]);
      add(`${theme} .sub-alert-${p} word`, over(resolve(decl(rules, `.sub-alert-${p}`, "color", theme), T), f), f, 4.5);
    }
    // The members page's zero-count pills, on the distribution panel.
    const panel = over(resolve(decl(rules, ".admin-members-distribution", "background", theme), T), S["--bg"]);
    add(`${theme} zero-count pill word`, over(resolve(decl(rules, ".admin-members-distribution-pill.is-zero .sub-pill", "color", theme), T), panel), panel, 4.5);
    for (const sel of [".btn-primary", ".btn-primary:hover:not(:disabled)"]) {
      const f = over(resolve(decl(rules, sel, "background", theme), T), S["--bg-1"]);
      add(`${theme} ${sel} word on its fill`, over(resolve(decl(rules, ".btn-primary", "color", theme), T), f), f, 4.5);
    }
    add(`${theme} .btn-danger word on --bg-1`, over(resolve(decl(rules, ".btn-danger", "color", theme), T), S["--bg-1"]), S["--bg-1"], 4.5);
    for (const f of ["--green", "--red"]) add(`${theme} toast word (--bg) on ${f}`, solid("--bg"), solid(f), 4.5);
    for (const t of Object.keys(T).filter((k) => k.startsWith("--chart-")))
      for (const s of ["--bg", "--bg-1"]) add(`${theme} ${t} as a mark on ${s}`, solid(t), S[s], 3);
    // Valuation ramps, mixed toward --text (components/rampInk.ts).
    const ramps = [...hexes(read("components/autoBuy/ValuationTab.tsx")), ...hexes(read("components/autoBuy/InputsTab.tsx")), ...hexes(read("components/valuation/YearHeatmap.tsx"))];
    for (const c of new Set(ramps)) for (const s of ["--bg", "--bg-1", "--bg-2"]) {
      add(`${theme} ramp ${c} as text on ${s}`, over(resolve(`color-mix(in srgb, ${c}, var(--text) ${T["--ramp-ink"]})`, T), S[s]), S[s], 4.5);
      add(`${theme} ramp ${c} as a mark on ${s}`, over(resolve(`color-mix(in srgb, ${c}, var(--text) ${T["--ramp-mark"]})`, T), S[s]), S[s], 3);
    }
    // The calendar's per-day count over its completeness tints (MonthGrid).
    const mg = read("components/valuation/MonthGrid.tsx");
    const countColour = mg.match(/fontSize: "0\.6875rem", color: "(var\(--[a-z0-9-]+\))"/)![1];
    for (const t of mg.match(/rgba\([^)]*\)/g) ?? []) {
      const cell = over(resolve(t, T), S["--bg-1"]);
      add(`${theme} calendar count on ${t}`, over(resolve(countColour, T), cell), cell, 4.5);
    }
  }
  return out;
}

const failing = (ps: Pairing[]) => ps.filter((p) => p.ratio < p.need).map((p) => `${p.name}: ${p.ratio.toFixed(2)}:1 < ${p.need}`);

function mutated(edit: (css: string) => string): string {
  const src = readFileSync(join(__dirname, "styles.css"), "utf8");
  const out = edit(src);
  if (out === src) throw new Error("negative control's edit did not apply");
  const dir = mkdtempSync(join(tmpdir(), "colour-nc-"));
  const f = join(dir, "styles.css");
  writeFileSync(f, out);
  return f;
}

describe("colour round: every token pairing at its ruled ratio, both themes", () => {
  it("covers the ruled pairings", () => {
    // 400 at the colour round (PR 8); a smaller number means a check fell out.
    expect(pairings().length).toBeGreaterThanOrEqual(400);
  });

  it("none fails", () => {
    expect(failing(pairings())).toEqual([]);
  });

  // WebKit (Safari, the iPhone) draws an unclassed field's edge at 1.2–1.9:1;
  // the zero-specificity base rule gives every such field --border-control.
  it("browser-drawn text fields and selects are bounded by --border-control", () => {
    expect(browserFieldBorder()).toBe("1px solid var(--border-control)");
  });
});

function browserFieldBorder(file = join(__dirname, "styles.css")): string | undefined {
  const r = cssRules(file).find((x) => x.media === null && x.selectors.some((s) => s.startsWith(":where(input:not(")));
  return r?.decls["border"];
}

describe("negative controls: each planted old value fails for its own pairing", () => {
  it("light --text-3 back to #998a78 fails as text", () => {
    const f = failing(pairings(mutated((c) => c.replace("--text-3:      #665a4d;", "--text-3:      #998a78;"))));
    expect(f.some((x) => x.startsWith("light --text-3 as text on --bg-1:"))).toBe(true);
  });

  it("light --amber back to #d97706 fails as a mark", () => {
    const f = failing(pairings(mutated((c) => c.replace("--amber:       #a75c05;", "--amber:       #d97706;"))));
    expect(f.some((x) => x.startsWith("light --amber as a mark on --bg-3:"))).toBe(true);
    expect(f.some((x) => x.startsWith("light --text"))).toBe(false);
  });

  it("the primary button back to today's amber fill with near-black text fails in light", () => {
    const f = failing(pairings(mutated((c) => c.replace(
      /(\.btn-primary \{[^}]*?)background: var\(--text\);\s*color: var\(--bg\);/,
      "$1background: var(--amber);\n  color: #0a0a0c;",
    ))));
    expect(f.some((x) => x.startsWith("light .btn-primary word on its fill:"))).toBe(true);
    expect(f.some((x) => x.startsWith("dark .btn-primary word on its fill:"))).toBe(false);
  });

  it("the zero-count pill faded back to --text-3 at 45% fails", () => {
    const f = failing(pairings(mutated((c) => c.replace(
      /(\.admin-members-distribution-pill\.is-zero \.sub-pill \{\s*color: )var\(--text-3\);/,
      "$1color-mix(in srgb, var(--text-3) 45%, transparent);",
    ))));
    expect(f.some((x) => x.startsWith("dark zero-count pill word:"))).toBe(true);
  });

  it("a light state colour back to its old value fails on its glow", () => {
    const f = failing(pairings(mutated((c) => c.replace("--green:       #10602e;", "--green:       #15803d;"))));
    expect(f.some((x) => x.startsWith("light .badge-green word on its fill over --bg-1:"))).toBe(true);
  });

  it("the browser-drawn field rule losing --border-control is seen", () => {
    const f = mutated((c) => c.replace(
      /(:where\(input:not\([^{]*\{\s*)border: 1px solid var\(--border-control\);/,
      "$1border: 1px solid var(--border);",
    ));
    expect(browserFieldBorder(f)).toBe("1px solid var(--border)");
  });

  it("a control boundary back on --border fails", () => {
    const f = failing(pairings(mutated((c) => c.replace("--border-control: #857560;", "--border-control: #cdc3b3;"))));
    expect(f.some((x) => x.startsWith("light --border-control on --bg-1:"))).toBe(true);
  });
});
