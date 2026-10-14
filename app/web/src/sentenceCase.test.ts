// P6-2 (PR 6): alert headings and PR 6's new dashboard labels are sentence
// case — in the copy, with no text-transform turning them to capitals.
// .panel-title and the other uppercase rules are unchanged (the ruling's
// boundary, pinned here so a sweep can't quietly widen it).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, declsFor } from "./styleRules.testutil";
import { MEMBER_NAME_PROMPT_HEADLINE } from "./components/memberNamePrompt";

const RULES = cssRules();

/** Every rule (any @media) whose selector list names `cls`. */
const rulesNaming = (cls: string) => RULES.filter((r) => r.selectors.some((s) => s.split(/[\s>+~:]+/).includes(cls)));

const SENTENCE_CASE = [
  ".alert-type",        // every alert heading in the app
  ".alert-row-heading", // X3's compact rows
  ".hl-label",          // H2's headline labels
  ".hl-sub",
  ".figure-label",
  ".kv-label",
  ".kv-meta",
];

describe("P6-2: no text-transform turns these to capitals", () => {
  for (const cls of SENTENCE_CASE) {
    it(cls, () => {
      for (const r of rulesNaming(cls)) {
        expect(r.decls["text-transform"], `${r.media ?? ""} ${r.selectors.join(", ")} (line ${r.line})`).toBeUndefined();
      }
    });
  }

  it("the boundary: .panel-title stays uppercase", () => {
    expect(declsFor(".panel-title")["text-transform"]).toBe("uppercase");
  });
});

// Words that keep their capital in sentence case.
const PROPER = new Set(["API", "Auto-Buy", "BitCorn", "Bitcorn", "Bitcoin", "BTC", "Coinbase", "Lightning", "Loop", "LND", "USDC"]);

function offenders(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z-]*/g) ?? [];
  return words.slice(1).filter((w) => /^[A-Z]/.test(w) && !PROPER.has(w));
}

function tsxSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxSources(p));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("P6-2: alert headings are written in sentence case", () => {
  const headings: { file: string; text: string }[] = [];
  for (const file of tsxSources(__dirname)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/className="alert-type">([^<]*)</g)) {
      // Literal copy only: {expressions} are checked at their source below.
      const literal = m[1].replace(/\{[^}]*\}/g, " ").trim();
      if (literal) headings.push({ file: file.slice(__dirname.length + 1), text: literal });
    }
  }

  it("the scan finds the literal headings (it is not vacuous)", () => {
    expect(headings.length).toBeGreaterThanOrEqual(6);
  });

  it("no word after the first is capitalised, proper names aside", () => {
    const bad = headings.filter((h) => offenders(h.text).length > 0);
    expect(bad).toEqual([]);
  });

  it("the name prompt's headline, rendered through a constant", () => {
    expect(offenders(MEMBER_NAME_PROMPT_HEADLINE)).toEqual([]);
  });
});
