// X4b (PR 7): on a phone the J2 tables become cards, by opt-in class (R4).
// jsdom evaluates no @media, so the rules are read; the browser matrix is the
// evidence of what renders.
//
// Scope (R4): .phone-card sits on the six J2 tables and nowhere else, and the
// card rules select only .phone-card, so the other .data-table tables
// (Payments history, Peers, Swap operations, Cash Out history, Liquidity's
// External & Unclassified) keep today's sideways scroll, and the tables
// outside .data-table (admin members, auto-buy's alerts, inputs and history)
// are untouched.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, type CssRule } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";
const RULES = cssRules();
const CARD = RULES.filter((r) => r.selectors.some((s) => s.includes(".phone-card")));
const card = (suffix: string) =>
  CARD.find((r) => r.media === PHONE && r.selectors.includes(`:is(.data-table, .sub-history-table).phone-card${suffix}`))?.decls ?? {};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("X4b: a J2 table is a card on a phone", () => {
  it("the rules exist, all under the phone query (not vacuous)", () => {
    expect(CARD.length).toBeGreaterThanOrEqual(10);
    for (const r of CARD) expect(r.media, `line ${r.line}`).toBe(PHONE);
  });

  it("the header row and column widths go; the table and body become blocks", () => {
    expect(card(" :is(thead, colgroup)")["display"]).toBe("none");
    expect(card("")["display"]).toBe("block");
    expect(card("")["min-width"]).toBe("0");
    expect(card(" tbody")["display"]).toBe("block");
  });

  it("a row wraps its cells; the title cell takes the first line", () => {
    expect(card(" tr")["display"]).toBe("flex");
    expect(card(" tr")["flex-wrap"]).toBe("wrap");
    expect(card(" td.td-primary")["flex"]).toBe("1 0 100%");
  });

  it("every other cell shows its column's name beside its value, as one unit", () => {
    expect(card(" td:not(.td-primary)::before")["content"]).toBe("attr(data-label)");
    expect(card(" td")["display"]).toBe("flex");
    expect(card(" td")["white-space"]).toBe("nowrap");
  });

  it("a detail row spans the card with no label; an empty cell drops out", () => {
    expect(card(" tr.row-detail td")["flex"]).toBe("1 0 100%");
    expect(card(" tr.row-detail td::before")["content"]).toBe("none");
    expect(card(" td:empty")["display"]).toBe("none");
  });

  it("nothing hides a column in a card (X4b: nothing hidden)", () => {
    // The only things a card hides: the header row, the column widths, and a
    // cell with nothing in it.
    const hides = CARD.filter((r: CssRule) => r.decls["display"] === "none")
      .flatMap((r) => r.selectors)
      .filter((s) => !/:is\(thead, colgroup\)$|td:empty$/.test(s));
    expect(hides).toEqual([]);
  });
});

describe("R4: the J2 tables only", () => {
  const files = sources(__dirname);
  const uses = files.flatMap((f) => (readFileSync(f, "utf8").match(/phone-card/g) ?? []).map(() => f.replace(__dirname + "/", "")));

  it("six tables: ChannelsPage's four lanes, Top Up's history, subscription payments", () => {
    const count = (f: string) => uses.filter((u) => u === f).length;
    expect(count("App.tsx")).toBe(4);
    expect(count("pages/RefillChannel.tsx")).toBe(1);
    expect(count("pages/SubscriptionPayments.tsx")).toBe(1);
    expect(new Set(uses)).toEqual(new Set(["App.tsx", "pages/RefillChannel.tsx", "pages/SubscriptionPayments.tsx"]));
  });

  it("no card rule reaches a table that has not opted in", () => {
    for (const r of RULES.filter((x) => x.media === PHONE)) {
      for (const s of r.selectors) {
        if (/::before|td:empty|tr\.row-detail|td\.td-primary/.test(s)) {
          expect(s, `line ${r.line}`).toContain(".phone-card");
        }
      }
    }
  });
});
