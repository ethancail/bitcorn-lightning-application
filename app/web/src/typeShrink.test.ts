// PR 9, PR9-R3 (T2): a narrower screen never takes a label UNDER the 9px
// floor. Before PR 9, `@media (max-width: 600px)` set .channel-balance-labels
// to 0.5625rem (7.9px), below both the floor and its own 0.625rem base. The
// rule is gone; this keeps any @media rule from setting a font size under the
// floor (P5: 9px at text 1.0, the 14px root). A phone size that shrinks but
// stays at or above 9px (.channel-peer's 0.75rem) is allowed.
// Read from styles.css (jsdom does not evaluate @media).

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, type CssRule } from "./styleRules.testutil";

const FLOOR_PX = 9;
const ROOT_PX = 14;

function px(v: string | undefined): number | null {
  const m = /^([\d.]+)(rem|px)$/.exec((v ?? "").trim());
  if (!m) return null;
  return m[2] === "rem" ? Number(m[1]) * ROOT_PX : Number(m[1]);
}

/** Every @media font size that is under the floor, as messages. */
function mediaUnderFloor(rules: CssRule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.media === null) continue;
    const size = px(r.decls["font-size"]);
    if (size !== null && size < FLOOR_PX) {
      out.push(`${r.selectors.join(", ")} @media ${r.media} (line ${r.line}): ${r.decls["font-size"]} = ${size.toFixed(2)}px`);
    }
  }
  return out;
}

describe("PR9-R3: no @media rule takes a label under 9px", () => {
  const rules = cssRules();

  it("not vacuous: styles.css has @media rules that set a font size", () => {
    expect(rules.filter((r) => r.media !== null && px(r.decls["font-size"]) !== null).length).toBeGreaterThanOrEqual(3);
  });

  it("every @media font size is at or above 9px at text 1.0", () => {
    expect(mediaUnderFloor(rules)).toEqual([]);
  });

  it("negative control: the deleted phone shrink is caught, and a 9px one is not", () => {
    const css = readFileSync(join(__dirname, "styles.css"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "type-shrink-"));
    const f = join(dir, "planted.css");
    writeFileSync(
      f,
      css +
        "\n@media (max-width: 600px) { .channel-balance-labels { font-size: 0.5625rem; } }" +
        "\n@media (max-width: 600px) { .planted-at-floor { font-size: 9px; } }\n",
    );
    const found = mediaUnderFloor(cssRules(f));
    expect(found.some((m) => m.startsWith(".channel-balance-labels") && m.includes("7.88px"))).toBe(true);
    expect(found.some((m) => m.startsWith(".planted-at-floor"))).toBe(false);
  });
});
