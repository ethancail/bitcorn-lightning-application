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
  const usesOf = (cls: string) =>
    files.flatMap((f) => (readFileSync(f, "utf8").match(new RegExp(`(?<![\\w-])${cls}(?![\\w-])`, "g")) ?? []).map(() => f.replace(__dirname + "/", "")));

  it("six tables: ChannelsPage's four lanes and subscription payments are cards; Top Up's history fits (X4c)", () => {
    const cards = usesOf("phone-card");
    const count = (f: string) => cards.filter((u) => u === f).length;
    expect(count("App.tsx")).toBe(4);
    expect(count("pages/SubscriptionPayments.tsx")).toBe(1);
    expect(new Set(cards)).toEqual(new Set(["App.tsx", "pages/SubscriptionPayments.tsx"]));
    expect(usesOf("phone-fit")).toEqual(["pages/RefillChannel.tsx"]);
    expect(usesOf("phone-fit-wrap")).toEqual(["pages/RefillChannel.tsx"]);
  });

  it("no card rule reaches a table that has not opted in", () => {
    for (const r of RULES.filter((x) => x.media === PHONE)) {
      for (const s of r.selectors) {
        if (/::before|td:empty|tr\.row-detail|td\.td-primary/.test(s)) {
          expect(s, `line ${r.line}`).toMatch(/\.phone-card|\.phone-fit/);
        }
      }
    }
  });
});

describe("X4c: Top Up's history is one line where every row fits, a card otherwise", () => {
  // The threshold as the stylesheet states it (read, not restated here).
  const THRESHOLD =
    RULES.map((r) => r.container?.match(/^topup-history \(width >= (calc\([^)]*\))\)$/)?.[1]).find(Boolean) ?? "(none)";
  const WIDE = `topup-history (width >= ${THRESHOLD})`;
  const NARROW = `topup-history (width < ${THRESHOLD})`;
  const inWide = RULES.filter((r) => r.media === PHONE && r.container === WIDE);
  const inNarrow = RULES.filter((r) => r.media === PHONE && r.container === NARROW);

  it("the wrapper is the named size container, on a phone", () => {
    const wrap = RULES.find((r) => r.media === PHONE && r.container === null && r.selectors.includes(".phone-fit-wrap"));
    expect(wrap?.decls["container"]).toBe("topup-history / inline-size");
  });

  it("one threshold, in both directions, in em plus px: the two queries are complements", () => {
    expect(THRESHOLD).toMatch(/^calc\([\d.]+em \+ \d+px\)$/);
    const conditions = new Set(RULES.filter((r) => r.container?.startsWith("topup-history")).map((r) => r.container));
    expect(conditions).toEqual(new Set([WIDE, NARROW]));
  });

  it("wide enough: one line, the secondary column (Fee) hidden, no 600px minimum", () => {
    const decls = (sel: string) => inWide.find((r) => r.selectors.includes(sel))?.decls ?? {};
    expect(decls(".data-table.phone-fit")["min-width"]).toBe("0");
    expect(decls(".data-table.phone-fit")["table-layout"]).toBe("auto");
    expect(decls(".data-table.phone-fit :is(colgroup, .col-secondary)")["display"]).toBe("none");
  });

  it("too narrow: exactly the .phone-card card, rule for rule", () => {
    const cardRules = CARD.filter((r) => r.media === PHONE && r.container === null);
    expect(inNarrow.length).toBe(cardRules.length);
    for (const r of cardRules) {
      const suffix = r.selectors[0].replace(":is(.data-table, .sub-history-table).phone-card", "");
      const twin = inNarrow.find((n) => n.selectors.includes(`.data-table.phone-fit${suffix}`));
      expect(twin, `the card rule "${suffix || "(table)"}" has its .phone-fit twin`).toBeDefined();
      expect(twin!.decls, `"${suffix || "(table)"}"`).toEqual(r.decls);
    }
  });

  it("the threshold covers every measured reading (X4c-1, both engines, all 16 stops)", () => {
    // Widest one-line table, px, at each stop 0.75…1.50, from the measuring
    // build (never committed): ~/.bitcorn-dev/audit/2026-10-14-ui-redesign-pr7/x4c-readings.md.
    const CHROMIUM = [279, 291, 303, 315, 327, 339, 351, 363, 374, 386, 398, 410, 422, 434, 445, 457];
    const WEBKIT = [280, 291, 303, 315, 327, 339, 351, 363, 375, 387, 399, 411, 423, 435, 447, 459];
    const [, em, px] = THRESHOLD.match(/^calc\(([\d.]+)em \+ (\d+)px\)$/)!.map(Number);
    CHROMIUM.forEach((c, i) => {
      const s = 0.75 + i * 0.05;
      const need = Math.max(c, WEBKIT[i]);
      expect(em * 14 * s + px, `stop ${s.toFixed(2)}`).toBeGreaterThanOrEqual(need);
    });
  });
});
