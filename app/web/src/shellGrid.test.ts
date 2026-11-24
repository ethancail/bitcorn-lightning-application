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

  // Slice 5, ruling (1): the same bug, in the phone column. `1fr` let the top
  // bar's min-content (the nowrap node name) widen the one column to 394.7px
  // at a 390px screen, so the page scrolled sideways by 4.7px and the J8
  // ellipsis never engaged. jsdom evaluates no @media, so the rule is read.
  it("on a phone, the one column cannot grow past the screen", () => {
    expect(declsFor(".app-shell", "(max-width: 767px)")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });

  it("on desktop, the content column cannot grow past its track either", () => {
    expect(declsFor(".app-shell")["grid-template-columns"]).toBe("220px minmax(0, 1fr)");
  });
});
