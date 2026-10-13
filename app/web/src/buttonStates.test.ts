// Press and focus states for every button (PR 2). PR 1 gave .btn a press cue
// and the house focus ring (styles.css .btn:active / .btn:focus-visible); the
// inline-styled buttons, 56 without .btn at develop 247db99, got neither. A
// base `button` rule now carries both, with the same reduced-motion variant.
//
// Read from styles.css; jsdom evaluates neither :focus-visible nor @media.
// The capture pass's keyboard-focus shot is the rendered evidence.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { declsFor } from "./styleRules.testutil";

const REDUCED = "(prefers-reduced-motion: reduce)";

describe("every button: press and focus", () => {
  it("focus-visible draws the house ring on any button", () => {
    expect(declsFor("button:focus-visible")).toMatchObject({
      outline: "2px solid var(--focus-ring)",
      "outline-offset": "2px",
    });
  });

  it("an enabled button scales slightly while pressed", () => {
    expect(declsFor("button:active:not(:disabled)").transform).toBe("scale(0.97)");
    expect(declsFor("button").transition).toBe("transform 160ms cubic-bezier(0.23, 1, 0.32, 1)");
  });

  it("under reduced motion the press is an opacity cue, not movement", () => {
    expect(declsFor("button:active:not(:disabled)", REDUCED)).toEqual({ transform: "none", opacity: "0.85" });
  });

  it("no button's inline style suppresses the outline (an inline style beats the rule)", () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
      });
    for (const p of walk(__dirname)) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/outline:\s*("none"|'none'|0\b|"0")/g)) {
        hits.push(`${relative(__dirname, p)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
