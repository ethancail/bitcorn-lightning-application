// The shell grid (PR 2): windows shorter than about 795px no longer scroll
// the whole page by ~10px. The content row was `1fr`, i.e. minmax(auto, 1fr),
// so the sidebar's content height floored it past 100vh. These pin the rule;
// the 1440x700 capture (page height == window height) is the evidence.

import { describe, expect, it } from "vitest";
import { declsFor } from "./styleRules.testutil";

describe("app shell grid", () => {
  it("the content row cannot grow past the viewport", () => {
    const rows = declsFor(".app-shell")["grid-template-rows"];
    expect(rows).toBe("56px minmax(0, 1fr)");
  });

  it("the sidebar scrolls in its own column instead", () => {
    expect(declsFor(".sidebar")["overflow-y"]).toBe("auto");
  });
});
