// V9: the light-theme logo is fixed in the asset itself — a second SVG with
// dark fills — and styles.css shows exactly one asset per theme.
//
// The cascade is checked for real: styles.css is loaded into jsdom and the
// two <img>s' computed display is read under each [data-theme]. A text
// match on the CSS would pass a rule that a later one overrides.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const DARK_SVG = read("assets/bitcorn-logo.svg");
const LIGHT_SVG = read("assets/bitcorn-logo-light.svg");

const fills = (svg: string) => [...svg.matchAll(/fill:(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());

describe("V9 light logo asset", () => {
  it("the dark asset is still the cream one (the control the light asset is measured against)", () => {
    expect(fills(DARK_SVG).length).toBe(12);
    expect(new Set(fills(DARK_SVG))).toEqual(new Set(["#fffdf6"]));
  });

  it("the light asset draws every path in #1c1408 and none in cream", () => {
    expect(fills(LIGHT_SVG).length).toBe(fills(DARK_SVG).length);
    expect(new Set(fills(LIGHT_SVG))).toEqual(new Set(["#1c1408"]));
  });

  it("the light asset is the dark asset with only its fills changed", () => {
    const shape = (svg: string) => svg.replace(/fill:#[0-9a-fA-F]{6}/g, "fill:X");
    expect(shape(LIGHT_SVG)).toBe(shape(DARK_SVG));
  });
});

describe("V9 one logo per theme (styles.css, computed)", () => {
  let style: HTMLStyleElement | null = null;

  afterEach(() => {
    style?.remove();
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  function shown(theme: "dark" | "light") {
    style = document.createElement("style");
    style.textContent = read("styles.css");
    document.head.appendChild(style);
    document.documentElement.dataset.theme = theme;
    document.body.innerHTML =
      '<div class="topbar-logo">' +
      '<img class="topbar-logo-img topbar-logo-dark" alt="Bitcorn">' +
      '<img class="topbar-logo-img topbar-logo-light" alt="Bitcorn">' +
      "</div>";
    const vis = (cls: string) => getComputedStyle(document.querySelector(`.${cls}`)!).display !== "none";
    return { dark: vis("topbar-logo-dark"), light: vis("topbar-logo-light") };
  }

  it("dark theme shows the cream asset only", () => {
    expect(shown("dark")).toEqual({ dark: true, light: false });
  });

  it("light theme shows the #1c1408 asset only", () => {
    expect(shown("light")).toEqual({ dark: false, light: true });
  });
});
