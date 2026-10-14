// Z2 (UI redesign round 1): ONE UI font with TABULAR digits; monospace only for
// identifiers. --sans and --mono both follow --font, so every rule and
// component reading --mono (Daybreak's gauge among them) renders numbers and
// labels in the UI font; identifiers read --font-id, directly or through .ident.
// Tabular digits are set on the root and on form controls, whose `font` the UA
// stylesheet resets.
//
// Read from styles.css as rules (styleRules.testutil): jsdom does not resolve
// custom properties, and the browser captures are the evidence of what renders.

import { describe, expect, it } from "vitest";
import { cssRules, declsFor } from "./styleRules.testutil";

const RULES = cssRules();

describe("Z2: one UI font with tabular digits; --font-id for identifiers", () => {
  it(":root derives --sans and --mono from --font, and sets tabular digits", () => {
    const root = declsFor(":root", null, RULES);
    expect(root["--sans"]).toBe("var(--font)");
    expect(root["--mono"]).toBe("var(--font)");
    expect(root["font-family"]).toBe("var(--font)");
    expect(root["font-variant-numeric"]).toBe("tabular-nums");
  });

  it("no other rule re-values --sans or --mono (a theme cannot bring monospace back)", () => {
    const offenders = RULES
      .filter((r) => !(r.media === null && r.selectors.length === 1 && r.selectors[0] === ":root"))
      .filter((r) => "--sans" in r.decls || "--mono" in r.decls)
      .map((r) => `${r.selectors.join(", ")} @ styles.css:${r.line}`);
    expect(offenders).toEqual([]);
  });

  it("form controls get tabular digits", () => {
    for (const el of ["button", "input", "select", "textarea"]) {
      expect(declsFor(el, null, RULES)["font-variant-numeric"], el).toBe("tabular-nums");
    }
  });

  it(".ident comes after every single-class rule that sets font-family (it shares elements with .mono and .td-mono)", () => {
    const single = (r: (typeof RULES)[number]) => r.media === null && r.selectors.length === 1 && /^\.[\w-]+$/.test(r.selectors[0]);
    const ident = RULES.filter((r) => single(r) && r.selectors[0] === ".ident");
    expect(ident).toHaveLength(1);
    const later = RULES
      .filter((r) => single(r) && r.selectors[0] !== ".ident" && "font-family" in r.decls && r.line > ident[0].line)
      .map((r) => `${r.selectors[0]} @ styles.css:${r.line}`);
    expect(later).toEqual([]);
    // anti-vacuity: .td-mono and .mono are such rules, and both precede it
    for (const sel of [".td-mono", ".mono"]) {
      const r = RULES.find((x) => single(x) && x.selectors[0] === sel && "font-family" in x.decls);
      expect(r && r.line < ident[0].line, sel).toBe(true);
    }
  });

  it(".ident and the identifier classes read --font-id", () => {
    for (const sel of [".ident", ".topbar-node-id", ".bolt11-text", ".sub-pubkey", ".sub-deposit-address",
      ".stablecoin-address", ".stablecoin-mini-address", ".stablecoin-row-address", ".stablecoin-row-link",
      ".stablecoin-empty-address"]) {
      expect(declsFor(sel, null, RULES)["font-family"], sel).toBe("var(--font-id)");
    }
  });
});
