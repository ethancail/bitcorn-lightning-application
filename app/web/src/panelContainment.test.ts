// 3B (TASTE A15), PR 5: ONE level of containment. The panel is the only box;
// .panel-header is a title row inside it, with no strip of its own. Its
// spacing leans on the .panel-body below it, so a header with no body after
// it (17 of 77 at 5f37779) supplies its own gap, and a header alone in its
// panel gets the tile's full padding so .panel's overflow: hidden cannot clip
// the title. .panel itself is Daybreak's (F8): pinned unchanged here.
// Read from styles.css; the captures are the evidence of how it renders.

import { describe, expect, it } from "vitest";
import { declsFor } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";

describe("3B: one level of containment", () => {
  it(".panel is unchanged (Daybreak consumes it)", () => {
    expect(declsFor(".panel")).toEqual({
      background: "var(--bg-1)",
      border: "1px solid var(--border)",
      "border-radius": "var(--radius-lg)",
      overflow: "hidden",
    });
  });

  it("the header has no strip: no background, no rule of its own", () => {
    const h = declsFor(".panel-header");
    expect(h.background).toBeUndefined();
    expect(h["border-bottom"]).toBeUndefined();
    expect(declsFor(".panel.ops .panel-header").background).toBeUndefined();
  });

  it("the title sits --d-title-gap above a .panel-body (desktop and phone)", () => {
    expect(declsFor(".panel-header")).toMatchObject({
      padding: "var(--d-tile-pad) var(--d-tile-pad) 0",
      "margin-bottom": "calc(var(--d-title-gap) - var(--d-tile-pad))",
    });
    expect(declsFor(".panel-header", PHONE)).toMatchObject({
      padding: "var(--d-tile-pad-ph) var(--d-tile-pad-ph) 0",
      "margin-bottom": "calc(var(--d-title-gap) - var(--d-tile-pad-ph))",
    });
  });

  it("a header with no .panel-body after it supplies its own gap and pulls nothing up", () => {
    expect(declsFor(".panel-header:not(:has(+ .panel-body))")).toEqual({
      "padding-bottom": "var(--d-title-gap)",
      "margin-bottom": "0",
    });
  });

  it("a header alone in its panel keeps the tile's padding below it", () => {
    expect(declsFor(".panel-header:last-child")["padding-bottom"]).toBe("var(--d-tile-pad)");
    expect(declsFor(".panel-header:last-child", PHONE)["padding-bottom"]).toBe("var(--d-tile-pad-ph)");
  });
});
