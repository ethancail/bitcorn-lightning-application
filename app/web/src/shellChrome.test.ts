// 4B + J10 (PR 5): a translucent top bar with content scrolling beneath it,
// by GRID OVERLAP (P5-1) — the bar keeps row 1, and the sidebar and main
// column span both rows under it, so PR 2's row string (shellGrid.test.ts)
// is untouched. Also: the sidebar scrolls in its own column; focus and
// scrollIntoView land below the bar (scroll-padding); the phone drawer is
// solid (P5-4); and the fallbacks, which no browser tool here can switch on
// (Playwright cannot emulate prefers-reduced-transparency, and both engines
// support backdrop-filter), are proven from the rules themselves.
// Read from styles.css; the captures are the evidence of how it renders.

import { describe, expect, it } from "vitest";
import { cssRules, declsFor } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";
const RULES = cssRules();

describe("J10: the bar over a two-row shell", () => {
  it("the bar's height token agrees with the grid's first row", () => {
    const top = declsFor(":root")["--topbar-h"];
    expect(top).toBe("56px");
    expect(declsFor(".app-shell")["grid-template-rows"].split(" ")[0]).toBe(top);
  });

  it("the bar keeps row 1, across both columns, above the content", () => {
    expect(declsFor(".topbar")).toMatchObject({ "grid-row": "1", "grid-column": "1 / -1", "z-index": "50" });
  });

  it("the sidebar and the main column span both rows, beneath the bar", () => {
    expect(declsFor(".sidebar")).toMatchObject({ "grid-row": "1 / -1", "grid-column": "1", "overflow-y": "auto" });
    expect(declsFor(".main-content")).toMatchObject({ "grid-row": "1 / -1", "grid-column": "2", "overflow-y": "auto" });
    expect(declsFor(".app-shell")["grid-template-columns"]).toBe("220px minmax(0, 1fr)");
  });

  it("their content starts below the bar (desktop and phone)", () => {
    expect(declsFor(".sidebar").padding).toContain("var(--topbar-h)");
    expect(declsFor(".main-content").padding).toContain("var(--topbar-h)");
    expect(declsFor(".main-content", PHONE).padding).toContain("var(--topbar-h)");
    expect(declsFor(".main-content", PHONE)["grid-column"]).toBe("1");
  });

  it("focus moves and scrollIntoView land below the bar", () => {
    expect(declsFor(".main-content")["scroll-padding-top"]).toBe("calc(var(--topbar-h) + 8px)");
  });
});

describe("4B: translucent chrome, the bar and the desktop sidebar only", () => {
  it("the bar and the sidebar read the chrome tokens, both prefixes", () => {
    for (const sel of [".topbar", ".sidebar"]) {
      expect(declsFor(sel), sel).toMatchObject({
        background: "var(--chrome-bg)",
        "backdrop-filter": "var(--chrome-blur)",
        "-webkit-backdrop-filter": "var(--chrome-blur)",
      });
    }
    expect(declsFor(":root")["--chrome-bg"]).toBe("color-mix(in srgb, var(--bg-1) 78%, transparent)");
  });

  it("the phone drawer is solid (P5-4)", () => {
    expect(declsFor(".sidebar", PHONE)).toMatchObject({
      background: "var(--bg-1)",
      "backdrop-filter": "none",
      "-webkit-backdrop-filter": "none",
    });
  });

  it("nothing else is translucent chrome (AC8): only the bar, the sidebar, and the dialog scrim that predates PR 5", () => {
    const blurred = new Set<string>();
    const chrome = new Set<string>();
    for (const r of RULES) {
      if (r.decls["backdrop-filter"] && r.decls["backdrop-filter"] !== "none") r.selectors.forEach((s) => blurred.add(s));
      if (Object.values(r.decls).some((v) => v.includes("var(--chrome-bg)"))) r.selectors.forEach((s) => chrome.add(s));
    }
    expect([...blurred].sort()).toEqual([".dialog-overlay", ".sidebar", ".topbar"]);
    expect([...chrome].sort()).toEqual([".sidebar", ".topbar"]);
  });
});

describe("fallbacks: solid chrome", () => {
  it("under prefers-reduced-transparency", () => {
    expect(declsFor(":root", "(prefers-reduced-transparency: reduce)")).toEqual({
      "--chrome-bg": "var(--bg-1)",
      "--chrome-blur": "none",
    });
  });

  it("where backdrop-filter is unsupported (either prefix)", () => {
    const rule = RULES.find((r) => r.media?.startsWith("@supports not") && r.selectors.includes(":root"));
    expect(rule, "an @supports not (...) block for :root").toBeDefined();
    expect(rule!.media).toContain("(backdrop-filter: blur(1px))");
    expect(rule!.media).toContain("(-webkit-backdrop-filter: blur(1px))");
    expect(rule!.decls["--chrome-bg"]).toBe("var(--bg-1)");
  });
});
