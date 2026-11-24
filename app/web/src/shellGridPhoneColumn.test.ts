// Slice 5, ruling (1): the phone column cannot grow past the screen. At 390px
// the page was 4.7px wider than the screen: the phone rule's one column was
// `1fr`, i.e. minmax(auto, 1fr), so the top bar's min-content (the nowrap node
// name) widened it to 394.7px and the J8 ellipsis never engaged. The same bug
// shellGrid.test.ts pins for the content row. jsdom evaluates no @media, so
// the rule is read; the 390x844 captures (scrollWidth 390) are the evidence.
//
// These pins sit in their own file, not shellGrid.test.ts: vitestRunGuards
// .test.ts runs shellGrid.test.ts as its sample and counts its tests
// (Ethan's ruling, option (c), 2026-11-24).

import { describe, expect, it } from "vitest";
import { declsFor } from "./styleRules.testutil";

describe("app shell grid: the columns", () => {
  it("on a phone, the one column cannot grow past the screen", () => {
    expect(declsFor(".app-shell", "(max-width: 767px)")["grid-template-columns"]).toBe("minmax(0, 1fr)");
  });

  it("on desktop, the content column cannot grow past its track either", () => {
    expect(declsFor(".app-shell")["grid-template-columns"]).toBe("220px minmax(0, 1fr)");
  });
});
