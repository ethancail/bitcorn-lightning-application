// Slice 5 (Ethan's ruling, 2026-11-24): the top bar's sync dot keeps its
// 8x8 size. Once the phone column was held to the screen (ruling 1), the top
// bar's flex row shrank to fit 390px, and the dot, an empty span with no
// min-content, was squeezed to ~2x8px (shots/addon/after-dashboard-overflow-
// dark-390.png). jsdom does no layout, so the rule is read; the capture is
// the evidence of how it renders.

import { describe, expect, it } from "vitest";
import { declsFor } from "./styleRules.testutil";

describe("the top bar's sync dot", () => {
  it("does not shrink in a flex row", () => {
    expect(declsFor(".pulse-dot")["flex-shrink"]).toBe("0");
  });
});
