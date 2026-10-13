// SH6 (PR 2): the 26 fixed-pixel font sizes in the .sub-* block are rem, so
// they follow the text-size setting. The root is calc(14px * var(--text-scale))
// (styles.css :root), so each is its old px / 14: at 100% text size nothing
// moves; at any other size these texts now scale with the rest of the app.
// Among them: .sub-pubkey, the subscription transaction ID (§1's 12px entry),
// and .sub-panel-title h2 (§2's 11px entry).

import { describe, expect, it } from "vitest";
import { cssRules, declsFor } from "./styleRules.testutil";

/** Selector → its px size at develop 247db99, before SH6. */
const WAS_PX: Record<string, number> = {
  ".sub-panel-glyph": 12, ".sub-panel-title h2": 11, ".sub-pill": 11, ".sub-tagline": 13,
  ".sub-prepay-bullets": 13, ".sub-reassure": 13, ".sub-alert": 13, ".sub-bracket-label": 11,
  ".sub-stat-label": 10, ".sub-stat-value": 18, ".sub-stat-suffix": 12, ".sub-deposit-address": 13,
  ".sub-deposit-helper": 12, ".sub-btn": 13, ".sub-link": 12, ".sub-timeline": 13,
  ".sub-body-copy": 13, ".sub-fineprint": 12, ".sub-footer-note": 12, ".sub-centered-headline": 18,
  ".sub-centered-body": 13, ".sub-stuck-escalation": 13, ".sub-pending-channel-age": 11,
  ".sub-retry-indicator": 12, ".sub-pubkey": 12, ".sub-error-detail": 11,
};

describe("SH6: .sub-* font sizes in rem", () => {
  it("no .sub-* rule sets a px font size", () => {
    const px = cssRules()
      .filter((r) => r.selectors.some((s) => s.includes(".sub-")) && /px\s*$/.test(r.decls["font-size"] ?? ""))
      .map((r) => `${r.selectors.join(", ")} (line ${r.line}): ${r.decls["font-size"]}`);
    expect(px).toEqual([]);
  });

  it("each of the 26 is its old px / 14, so 100% text size renders as before", () => {
    expect(Object.keys(WAS_PX).length).toBe(26);
    const rules = cssRules();
    for (const [sel, px] of Object.entries(WAS_PX)) {
      const fs = declsFor(sel, null, rules)["font-size"];
      expect(fs, sel).toMatch(/^\d*\.?\d+rem$/);
      expect(Math.abs(parseFloat(fs) * 14 - px), sel).toBeLessThan(0.001);
    }
  });

  it("the transaction ID scales: 150% text size gives 18px, not a fixed 12px", () => {
    expect(parseFloat(declsFor(".sub-pubkey")["font-size"]) * 14 * 1.5).toBeCloseTo(18, 2);
  });
});
