// PR 9, PR9-R1 (T5): the root size stays calc(14px * var(--text-scale)).
// Tranche 2 listed it as an item (the first spec, §3 :138); it was reviewed
// and NOT re-valued. Daybreak and its editor inherit it (U6a), and these
// tests model the 14px root as a literal rather than reading it, so a change
// here must re-measure each of them:
//   phoneTables.css.test.ts (X4c's threshold readings, em * 14 * s)
//   daybreak/DaybreakGauge.test.tsx (the Z number fits its viewBox only up
//     to a ~14.5px root at text 1.5)
//   densityTokens.test.ts, subRem.test.ts, components/priceChartFormat.test.ts,
//   typeFloor.test.ts
// Read from styles.css (jsdom does not evaluate the cascade from a file).

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, type CssRule } from "./styleRules.testutil";

const ROOT = "calc(14px * var(--text-scale))";
const MODELS_14 =
  "phoneTables.css.test.ts, daybreak/DaybreakGauge.test.tsx, densityTokens.test.ts, subRem.test.ts, components/priceChartFormat.test.ts, typeFloor.test.ts";

/** Every problem with the root size, as messages; [] when it is ROOT, once. */
function rootProblems(rules: CssRule[]): string[] {
  const roots = rules.filter((r) => r.selectors.some((s) => s === ":root" || s === "html") && "font-size" in r.decls);
  const problems = roots
    .filter((r) => r.media !== null || r.container !== null || r.decls["font-size"] !== ROOT)
    .map((r) => `line ${r.line} (${r.media ?? "top level"}): font-size ${r.decls["font-size"]}`);
  if (roots.length !== 1) problems.push(`expected one root font-size, found ${roots.length}`);
  return problems.map((p) => `${p} — a root change re-values every screen and Daybreak; re-measure ${MODELS_14}`);
}

describe("PR9-R1: the root size is unchanged", () => {
  it(`:root sets font-size: ${ROOT}, once, at top level`, () => {
    expect(rootProblems(cssRules())).toEqual([]);
  });

  it("negative control: a re-valued root, and a second root rule, are both caught", () => {
    const css = readFileSync(join(__dirname, "styles.css"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "root-size-"));
    const revalued = join(dir, "revalued.css");
    writeFileSync(revalued, css.replace(ROOT, "calc(15px * var(--text-scale))"));
    expect(rootProblems(cssRules(revalued)).join("\n")).toMatch(/font-size calc\(15px/);
    const second = join(dir, "second.css");
    writeFileSync(second, css + "\n@media (max-width: 767px) { html { font-size: 16px; } }\n");
    expect(rootProblems(cssRules(second)).join("\n")).toMatch(/max-width: 767px.*16px[\s\S]*found 2/);
  });
});
