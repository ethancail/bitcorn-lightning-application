// member-ui-fixes item 2 (ruling "2 S2 remove-inline"; decision record
// decisions/2026-10-16-member-ui-fixes-item-2-ios-input-zoom-coarse-pointer-16px-floor-inline-sizes-removed.md):
// iOS Safari zooms the page when a text field under 16px takes focus, and the
// 14px root (PR9-R1) puts every control under it. Under @media (pointer:
// coarse) every text-entry input, select and textarea is at least 16px, and
// never smaller than its own size. Three things have to hold for that:
//   1. no text-entry control carries an inline font size — an inline size
//      beats any stylesheet rule, so the floor could not reach it;
//   2. a pointer: coarse rule sets the floor on all three element kinds, and
//      not on checkboxes, radios, sliders or buttons;
//   3. the floor out-specifies every class rule that sizes a control (so it
//      wins wherever it sits, without !important), and no such rule is over
//      1rem (so the floor's 1rem term never shrinks a control).
// Read from source: jsdom evaluates neither @media nor the pointer. The
// browser harness at 390px (coarse) and 1440px (fine) is the evidence of what
// renders; the real-phone check is Ethan's.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, type CssRule } from "./styleRules.testutil";

const FLOOR = "max(16px, 1rem)";
const COARSE = /\(pointer:\s*coarse\)/;
const NON_TEXT = ["checkbox", "radio", "range", "color", "file", "hidden", "button", "submit", "reset", "image"];

type Control = { where: string; el: string; type: string; classes: string[]; inlineSize: boolean };

/** The text from `open` (the index after a "{") to its matching "}". */
function braced(src: string, open: number): string {
  let depth = 1, j = open;
  while (j < src.length && depth > 0) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") depth--;
    j++;
  }
  return src.slice(open, j - 1);
}

/** `const name = { … }` objects in a file, by name. */
function objectConsts(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*(?::[^=]+)?=\s*\{/g)) out.set(m[1], braced(src, m.index! + m[0].length));
  return out;
}

const SIZE = /\b(?:fontSize|font)\s*:/;

/** Does this text set a font size, directly or through a named object it
 *  spreads or passes as style? */
function setsSize(text: string, consts: Map<string, string>, seen = new Set<string>()): boolean {
  if (SIZE.test(text)) return true;
  for (const m of text.matchAll(/(?:\.\.\.|style=\{)(\w+)/g)) {
    const body = consts.get(m[1]);
    if (body !== undefined && !seen.has(m[1]) && setsSize(body, consts, seen.add(m[1]))) return true;
  }
  return false;
}

/** Every text-entry control opened in one .tsx source. */
function controls(src: string, file: string): Control[] {
  const consts = objectConsts(src);
  const out: Control[] = [];
  for (const m of src.matchAll(/<(input|textarea|select)\b/g)) {
    let depth = 0, end = m.index!;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index!, end + 1);
    const type = /\btype=\{?["'`]([\w-]+)["'`]/.exec(tag)?.[1] ?? "";
    if (m[1] === "input" && NON_TEXT.includes(type)) continue;
    const cls = /\bclassName=\{?["'`]([^"'`]*)["'`]/.exec(tag)?.[1] ?? "";
    out.push({
      where: `${file}:${src.slice(0, m.index).split("\n").length}`,
      el: m[1],
      type,
      classes: cls.split(/\s+/).filter((c) => /^[\w-]+$/.test(c)),
      inlineSize: setsSize(tag, consts),
    });
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Inline-sized controls, as messages. */
function inlineProblems(all: Control[]): string[] {
  return all.filter((c) => c.inlineSize).map((c) => `${c.where} <${c.el}> carries an inline font size`);
}

/** [a, b, c] specificity of one selector: ids, classes/attributes/pseudo-
 *  classes, types. :where() is zero; :is()/:not() take their most specific
 *  argument. */
function specificity(sel: string): [number, number, number] {
  const s: [number, number, number] = [0, 0, 0];
  let i = 0;
  const args = (from: number) => {
    let depth = 1, j = from;
    while (depth > 0) { if (sel[j] === "(") depth++; else if (sel[j] === ")") depth--; j++; }
    return { inner: sel.slice(from, j - 1), next: j };
  };
  while (i < sel.length) {
    const rest = sel.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^:(where|is|not)\(/.exec(rest))) {
      const { inner, next } = args(i + m[0].length);
      if (m[1] !== "where") {
        const best = splitTop(inner).map(specificity).sort(cmp).pop()!;
        s[0] += best[0]; s[1] += best[1]; s[2] += best[2];
      }
      i = next;
    } else if ((m = /^::[\w-]+/.exec(rest))) { s[2]++; i += m[0].length; }
    else if ((m = /^:[\w-]+(\()?/.exec(rest))) { s[1]++; i = m[1] ? args(i + m[0].length).next : i + m[0].length; }
    else if ((m = /^#[\w-]+/.exec(rest))) { s[0]++; i += m[0].length; }
    else if ((m = /^\.[\w-]+/.exec(rest))) { s[1]++; i += m[0].length; }
    else if ((m = /^\[[^\]]*\]/.exec(rest))) { s[1]++; i += m[0].length; }
    else if ((m = /^[a-zA-Z][\w-]*/.exec(rest))) { s[2]++; i += m[0].length; }
    else i++;
  }
  return s;
}

function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let k = 0; k < list.length; k++) {
    if (list[k] === "(") depth++;
    else if (list[k] === ")") depth--;
    else if (list[k] === "," && depth === 0) { out.push(list.slice(start, k).trim()); start = k + 1; }
  }
  out.push(list.slice(start).trim());
  return out;
}

function cmp(a: number[], b: number[]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The last compound of a selector (what the element itself must be). */
function lastCompound(sel: string): string {
  let depth = 0, cut = 0;
  for (let k = 0; k < sel.length; k++) {
    const c = sel[k];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) cut = k + 1;
  }
  return sel.slice(cut).replace(/:(?:focus|focus-visible|hover|active|disabled|read-only|placeholder-shown)\b/g, "");
}

/** One element per control found in source, to test selectors against. */
function samples(all: Control[]): Element[] {
  return all.map((c) => {
    const el = document.createElement(c.el);
    if (c.type) el.setAttribute("type", c.type);
    if (c.classes.length) el.className = c.classes.join(" ");
    return el;
  });
}

function toPx(v: string): number | null {
  const m = /^([\d.]+)(rem|px)$/.exec(v.trim());
  return m ? Number(m[1]) * (m[2] === "rem" ? 14 : 1) : null;
}

/** Rules outside the floor that set a size on a text-entry control, each
 *  checked against the floor: problems as messages. */
function cascadeProblems(rules: CssRule[], all: Control[], checked: string[] = []): string[] {
  const floors = rules.filter((r) => r.media && COARSE.test(r.media) && r.decls["font-size"] === FLOOR);
  if (floors.length === 0) return ["no pointer: coarse rule sets the floor"];
  const floorSpec = floors.flatMap((r) => r.selectors.map(specificity)).sort(cmp)[0];
  const els = samples(all);
  const out: string[] = [];
  for (const r of rules) {
    if (floors.includes(r)) continue;
    const size = r.decls["font-size"] ?? (r.decls.font ? /(?:^|\s)([\d.]+(?:rem|px))(?:\/|\s)/.exec(r.decls.font)?.[1] : undefined);
    if (size === undefined) continue;
    for (const sel of r.selectors) {
      const last = lastCompound(sel);
      let hits: boolean;
      try { hits = els.some((e) => e.matches(last || "*")); } catch { hits = false; }
      if (!hits) continue;
      checked.push(sel);
      const where = `${sel} (line ${r.line}${r.media ? `, @media ${r.media}` : ""})`;
      if (cmp(specificity(sel), floorSpec) >= 0) out.push(`${where} is (${specificity(sel)}) — the floor's (${floorSpec}) does not beat it`);
      const px = toPx(size);
      if (px === null || px > 14) out.push(`${where} sets ${size} — over 1rem, the floor would shrink it`);
    }
  }
  return out;
}

const SRC = sources(__dirname);
const ALL = SRC.flatMap((p) => controls(readFileSync(p, "utf8"), relative(__dirname, p)));
const RULES = cssRules();

describe("item 2: iOS input zoom — a 16px floor under a coarse pointer", () => {
  it("not vacuous: the scan finds the app's text-entry controls (45 at 46e57ea)", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(45);
    for (const el of ["input", "select", "textarea"]) expect(ALL.some((c) => c.el === el), el).toBe(true);
  });

  it("no text-entry control carries an inline font size, components/autoBuy/ included", () => {
    expect(inlineProblems(ALL)).toEqual([]);
  });

  it(`a pointer: coarse rule sets font-size: ${FLOOR} on text inputs, selects and textareas — and not on the other input types`, () => {
    const floors = RULES.filter((r) => r.media && COARSE.test(r.media) && r.decls["font-size"] === FLOOR);
    expect(floors.length).toBeGreaterThan(0);
    document.body.replaceChildren();
    const make = (tag: string, type?: string) => {
      const el = document.createElement(tag);
      if (type) el.setAttribute("type", type);
      document.body.appendChild(el);
      return el;
    };
    const floored = (el: Element) => floors.some((r) => r.selectors.some((s) => el.matches(s)));
    for (const t of [undefined, "text", "number", "url", "search", "email", "tel", "password"]) expect(floored(make("input", t)), `input type=${t}`).toBe(true);
    expect(floored(make("select")), "select").toBe(true);
    expect(floored(make("textarea")), "textarea").toBe(true);
    for (const t of NON_TEXT) expect(floored(make("input", t)), `input type=${t}`).toBe(false);
  });

  it("the floor beats every rule that sizes a control, on specificity, and none of them is over 1rem", () => {
    const checked: string[] = [];
    expect(cascadeProblems(RULES, ALL, checked)).toEqual([]);
    // not vacuous: the class rules that size today's controls were among those checked
    for (const sel of [".form-input", ".policy-card .policy-card-edit input", ".admin-members-search", ".stablecoin-input",
      ".form-input-sm", ".payment-request-input", ".daybreak-editor-field", ".identity-input", ".autobuy-filter", ".coinbase-key-input"]) expect(checked, sel).toContain(sel);
  });

  it("negative controls: the planted cases are caught, and checkboxes and ranges are ignored", () => {
    const planted = controls(
      [
        `const big = { fontSize: "0.75rem" };`,
        `const spread = { ...big, width: 1 };`,
        `<input className="form-input planted-cls" />`,
        `<textarea style={{ fontSize: "0.8rem" }} />`,
        `<input style={spread} />`,
        `<input type="checkbox" style={{ fontSize: "0.75rem" }} />`,
        `<input type="range" style={{ fontSize: "0.75rem" }} />`,
      ].join("\n"),
      "planted.tsx",
    );
    // the class-sized control is found, with its classes; checkbox and range are not controls
    expect(planted.map((c) => `${c.el}:${c.classes.join(".")}:${c.inlineSize}`)).toEqual([
      "input:form-input.planted-cls:false",
      "textarea::true",
      "input::true",
    ]);
    expect(inlineProblems(planted)).toHaveLength(2);

    // Against a planted floor of its own, so this reads the checker, not today's CSS.
    const rule = (selectors: string[], decls: Record<string, string>, media: string | null = null): CssRule => ({ media, container: null, selectors, decls, line: 0 });
    const caught = cascadeProblems(
      [
        rule([":root body :is(input, select, textarea)"], { "font-size": FLOOR }, "(pointer: coarse)"), // (0,1,2)
        rule([".planted-cls"], { "font-size": "0.75rem" }), // (0,1,0): beaten, under 1rem — fine
        rule([".a .b .planted-cls"], { "font-size": "0.75rem" }), // (0,3,0) out-specifies the floor
        rule(["textarea.planted-big"], { "font-size": "1.25rem" }), // over 1rem
        rule(['input[type="checkbox"]'], { "font-size": "0.5rem" }), // not a text-entry control
        rule(['input[type="range"]'], { "font-size": "0.5rem" }),
      ],
      [...planted, { where: "planted.tsx:9", el: "textarea", type: "", classes: ["planted-big"], inlineSize: false }],
    );
    expect(caught).toHaveLength(2);
    expect(caught.some((m) => m.startsWith(".a .b .planted-cls") && m.includes("does not beat"))).toBe(true);
    expect(caught.some((m) => m.startsWith("textarea.planted-big") && m.includes("over 1rem"))).toBe(true);

    // and with the floor gone, there is nothing to beat anything
    expect(cascadeProblems(RULES.filter((r) => !(r.media && COARSE.test(r.media))), ALL)).toEqual(["no pointer: coarse rule sets the floor"]);
  });
});
