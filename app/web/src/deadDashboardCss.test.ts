// P6-6 (PR 6): the dashboard CSS that H2 left with no consumer is cut — the
// treasury's balance strip, the member's status row and hero. .revenue-hero
// stays: RailFeeRevenuePanel still renders it. The scan is checked against a
// class that is still live, so it cannot pass by seeing nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules } from "./styleRules.testutil";

const CUT = ["dashboard-top-strip", "bal-group", "bal-item", "bal-label", "bal-value", "fund-error", "member-status-row", "member-hero"];

const RULES = cssRules();
const classesIn = (selector: string) => [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
const cssClasses = new Set(RULES.flatMap((r) => r.selectors.flatMap(classesIn)));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".testutil.ts")) out.push(p);
  }
  return out;
}
const code = sources(__dirname).map((f) => readFileSync(f, "utf8")).join("\n");
const usedInCode = (cls: string) => new RegExp(`["'\`\\s]${cls}["'\`\\s]`).test(code);

describe("P6-6: the dead dashboard CSS is gone", () => {
  it("the scan sees a live class in both places (not vacuous): .revenue-hero stays", () => {
    expect(cssClasses.has("revenue-hero")).toBe(true);
    expect(usedInCode("revenue-hero")).toBe(true);
  });

  for (const cls of CUT) {
    it(`.${cls}: no rule, no consumer`, () => {
      expect(cssClasses.has(cls), "a styles.css rule still names it").toBe(false);
      expect(usedInCode(cls), "a source file still renders it").toBe(false);
    });
  }
});

// PR 7: NodeBalancePanel and FundNodePanel had no importer since the
// 2026-04 dashboard polish; .dashboard-grid (and its .span-2) lost their
// last consumer with NodeBalancePanel.
describe("PR 7: the dead balance panels and their grid are gone", () => {
  for (const name of ["NodeBalancePanel", "FundNodePanel"]) {
    it(`${name}: no file, no import`, () => {
      expect(existsSync(join(__dirname, "components", `${name}.tsx`)), "the component file still exists").toBe(false);
      expect(code, "a source file still imports it").not.toMatch(new RegExp(`from ["'][./]*components/${name}["']`));
    });
  }

  for (const cls of ["dashboard-grid", "span-2"]) {
    it(`.${cls}: no rule, no consumer`, () => {
      expect(cssClasses.has(cls), "a styles.css rule still names it").toBe(false);
      expect(usedInCode(cls), "a source file still renders it").toBe(false);
    });
  }
});
