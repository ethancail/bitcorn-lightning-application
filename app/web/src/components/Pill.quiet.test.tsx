// The Quiet pill takes member-first-run-ui's ruled values ("recs",
// 2026-11-04; named Quiet in its pass 13, because the signal-system spec's
// "Gray (neutral)" is the pulsing grey of pending_initial_sync, gray-pulsing
// here): mark var(--text-3), edge var(--border), label var(--text), fill
// var(--bg-3). No new token. The old name, "neutral", is gone.
//
// Computed, not text-matched: jsdom does not substitute var() (it hands back
// "var(--text-2)" for color and drops the background/border shorthands to
// transparent), so its getComputedStyle cannot tell one token from another.
// This test renders the real <Pill> and runs the cascade itself over
// styles.css: jsdom's matches() says which top-level rules apply to the
// element, the winner is the highest specificity then the latest rule, color
// inherits, currentColor is the element's own colour, and var() resolves
// against :root under the theme. The browser captures are the evidence of
// what renders.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cssRules, specificity, type CssRule } from "../styleRules.testutil";
import { Pill, type PillKind } from "./Pill";

type Theme = "dark" | "light";
const ALL_RULES: CssRule[] = cssRules();
const RULES = ALL_RULES.filter((r) => r.media === null && r.container === null);

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

const KINDS: PillKind[] = ["emerald", "blue", "gray-pulsing", "muted-amber", "amber", "orange", "red", "dim-red", "quiet"];

// The old name is not a pill kind any more (checked by tsc: if "neutral"
// were still a PillKind, this directive would be unused and fail the build).
// @ts-expect-error — "neutral" was renamed "quiet"
const OLD_NAME: PillKind = "neutral";

/** Each kind rendered by the real component, in its own wrapper. */
function mount(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = KINDS.map((k) => `<div data-kind="${k}">${renderToStaticMarkup(<Pill kind={k} label="current" />)}</div>`).join("");
  const pill = (k: PillKind) => {
    const el = document.querySelector(`[data-kind="${k}"] .sub-pill`);
    if (!el) throw new Error(`Pill kind ${k} rendered no .sub-pill`);
    return el;
  };
  return {
    pill,
    label: (k: PillKind) => colour(pill(k)),
    edge: (k: PillKind) => computed(pill(k), ["border-color", "border"]),
    fill: (k: PillKind) => computed(pill(k), ["background-color", "background"]),
    mark: (k: PillKind) => computed(pill(k).querySelector(".sub-pill-dot")!, ["background-color", "background"]),
    tok: (name: string) => resolve(`var(${name})`, document.documentElement),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
});

describe("the old name is gone", () => {
  it("no rule in styles.css names .sub-pill-neutral, and the Quiet pill's rules exist", () => {
    const sels = ALL_RULES.flatMap((r) => r.selectors);
    expect(sels.filter((s) => s.includes("sub-pill-neutral"))).toEqual([]);
    expect(sels).toContain(".sub-pill-quiet");
    expect(sels).toContain(".sub-pill-quiet .sub-pill-dot");
  });

  it("<Pill kind=\"quiet\"> renders .sub-pill-quiet", () => {
    const c = mount("dark");
    expect(c.pill("quiet").className).toBe("sub-pill sub-pill-quiet");
    expect(OLD_NAME).toBe("neutral"); // the value tsc refuses as a PillKind
  });
});

describe.each(["dark", "light"] as const)("the Quiet pill, %s theme (member-first-run-ui's ruling)", (theme) => {
  it("label var(--text), edge var(--border), mark var(--text-3), fill var(--bg-3)", () => {
    const c = mount(theme);
    expect({ label: c.label("quiet"), edge: c.edge("quiet"), mark: c.mark("quiet"), fill: c.fill("quiet") }).toEqual({
      label: c.tok("--text"),
      edge: c.tok("--border"),
      mark: c.tok("--text-3"),
      fill: c.tok("--bg-3"),
    });
  });

  it("the mark is its own token, not the label's colour", () => {
    const c = mount(theme);
    expect(c.tok("--text-3")).not.toBe(c.tok("--text"));
    expect(c.mark("quiet")).not.toBe(c.label("quiet"));
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
