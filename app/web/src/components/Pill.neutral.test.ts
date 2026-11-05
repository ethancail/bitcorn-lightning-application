// The neutral pill takes member-first-run-ui's ruled values ("recs",
// 2026-11-04): mark var(--text-3), edge var(--border), label var(--text).
// The fill is outside the ruling and stays var(--bg-3). No new token.
//
// Computed, not text-matched: jsdom does not substitute var() (it hands back
// "var(--text-2)" for color and drops the background/border shorthands to
// transparent), so its getComputedStyle cannot tell one token from another.
// This test runs the cascade itself over styles.css: jsdom's matches() says
// which top-level rules apply to the element, the winner is the highest
// specificity then the latest rule, color inherits, currentColor is the
// element's own colour, and var() resolves against :root under the theme.
// The browser captures are the evidence of what renders.

import { afterEach, describe, expect, it } from "vitest";
import { cssRules, specificity, type CssRule } from "../styleRules.testutil";

type Theme = "dark" | "light";
const RULES: CssRule[] = cssRules().filter((r) => r.media === null && r.container === null);

const COLOUR = /^(var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8}|transparent|currentColor|rgba?\([^)]*\)|color-mix\(.*\))$/i;
/** The colour inside a shorthand ("1px solid var(--x)" → "var(--x)"). */
function colourOf(value: string): string | null {
  const v = value.replace("!important", "").trim();
  if (COLOUR.test(v)) return v;
  const last = v.split(/\s+(?![^(]*\))/).pop()!;
  return COLOUR.test(last) ? last : null;
}

function matches(el: Element, sel: string): boolean {
  try { return el.matches(sel); } catch { return false; } // ::before, etc.
}

/** The winning declared colour for one of `props` (longhand or shorthand). */
function declared(el: Element, props: string[]): string | null {
  let best: { spec: number; order: number; value: string } | null = null;
  RULES.forEach((r, order) => {
    for (const p of props) {
      if (!(p in r.decls)) continue;
      const value = colourOf(r.decls[p]);
      if (value === null) continue;
      for (const sel of r.selectors) {
        if (!matches(el, sel)) continue;
        const spec = specificity(sel);
        if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) best = { spec, order, value };
      }
    }
  });
  return best ? (best as { value: string }).value : null;
}

function token(name: string): string {
  const v = declared(document.documentElement, [name]);
  if (v === null) throw new Error(`undefined token ${name}`);
  return v;
}

function resolve(v: string, el: Element, depth = 0): string {
  if (depth > 12) throw new Error(`var cycle at ${v}`);
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (m) return resolve(token(m[1]), el, depth + 1);
  if (/^currentColor$/i.test(v)) return colour(el);
  return v.toLowerCase();
}

/** Computed `color`: declared, else inherited. */
function colour(el: Element): string {
  const d = declared(el, ["color"]);
  if (d !== null) return resolve(d, el);
  if (!el.parentElement) throw new Error("no color at the root");
  return colour(el.parentElement);
}

const computed = (el: Element, props: string[]) => {
  const d = declared(el, props);
  if (d === null) throw new Error(`no ${props.join("/")} on ${el.className}`);
  return resolve(d, el);
};

const KINDS = ["emerald", "blue", "gray-pulsing", "muted-amber", "amber", "orange", "red", "dim-red", "neutral"] as const;

function mount(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = KINDS.map(
    (k) => `<span class="sub-pill sub-pill-${k}"><span class="sub-pill-dot"></span>${k}</span>`,
  ).join("");
  const pill = (k: string) => document.querySelector(`.sub-pill-${k}`)!;
  return {
    label: (k: string) => colour(pill(k)),
    edge: (k: string) => computed(pill(k), ["border-color", "border"]),
    fill: (k: string) => computed(pill(k), ["background-color", "background"]),
    mark: (k: string) => computed(pill(k).querySelector(".sub-pill-dot")!, ["background-color", "background"]),
    tok: (name: string) => resolve(`var(${name})`, document.documentElement),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
});

describe.each(["dark", "light"] as const)("the neutral pill, %s theme (member-first-run-ui's ruling)", (theme) => {
  it("label var(--text), edge var(--border), mark var(--text-3), fill var(--bg-3)", () => {
    const c = mount(theme);
    expect({ label: c.label("neutral"), edge: c.edge("neutral"), mark: c.mark("neutral"), fill: c.fill("neutral") }).toEqual({
      label: c.tok("--text"),
      edge: c.tok("--border"),
      mark: c.tok("--text-3"),
      fill: c.tok("--bg-3"),
    });
  });

  it("the mark is its own token, not the label's colour", () => {
    const c = mount(theme);
    expect(c.tok("--text-3")).not.toBe(c.tok("--text"));
    expect(c.mark("neutral")).not.toBe(c.label("neutral"));
  });

  it("every other pill's mark is unchanged", () => {
    const c = mount(theme);
    expect({
      emerald: c.mark("emerald"),
      blue: c.mark("blue"),
      "gray-pulsing": c.mark("gray-pulsing"),
      "muted-amber": c.mark("muted-amber"),
      amber: c.mark("amber"),
      orange: c.mark("orange"),
      red: c.mark("red"),
      "dim-red": c.mark("dim-red"),
    }).toEqual({
      emerald: c.tok("--green"),
      blue: c.tok("--blue"),
      "gray-pulsing": c.tok("--text-2"),
      "muted-amber": c.tok("--amber"),
      amber: c.tok("--amber"),
      orange: c.tok("--orange"),
      red: c.tok("--red"),
      "dim-red": c.tok("--red"),
    });
  });
});
