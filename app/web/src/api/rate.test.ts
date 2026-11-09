// drive-mode P2, item 8: the no-price sentence covers both ways state "none"
// arises — a rate older than 6 hours, and a node that has never fetched one
// (fetched_at: null, as on a fresh boot). The old sentence claimed an age
// ("hasn't updated in over 6 hours"), which is false for the second.
//
// The sentence is asserted as a LITERAL, not by importing the constant:
// comparing a constant to itself would pass on any wording.

import { describe, it, expect } from "vitest";
import { rateNote } from "./rate";
import type { ExchangeRate } from "./client";

const SENTENCE = "The bitcoin price isn't available right now, so amounts are shown in sats.";

const rate = (o: Partial<ExchangeRate>): ExchangeRate => ({
  usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none", ...o,
});

describe("rateNote, state \"none\"", () => {
  it("a node that has never fetched a rate (fetched_at: null): the sentence claims no age", () => {
    expect(rateNote(rate({ fetched_at: null }))).toBe(SENTENCE);
  });

  it("a rate older than 6 hours: the same sentence", () => {
    expect(rateNote(rate({ fetched_at: 1_790_000_000_000, age_ms: 21_601_000 }))).toBe(SENTENCE);
  });

  it("neither case states an age it cannot know", () => {
    expect(rateNote(rate({}))).not.toMatch(/hours|updated/);
  });
});

// pay-from-node G3 ruling R7 (2026-11-06): a stale rate is dated with its day
// when it is not from today; from today, the time alone.
describe("rateNote, state \"stale\"", () => {
  const AT = new Date(2026, 10, 5, 23, 40).getTime(); // 5 Nov, 11:40 PM local
  const time = new Date(AT).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Date(AT).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const stale = rate({ usd: 60_000, fetched_at: AT, age_ms: 601_000, state: "stale" });

  it("from today: the time alone", () => {
    expect(rateNote(stale, new Date(2026, 10, 5, 23, 55).getTime())).toBe(`Price as of ${time}`);
  });

  it("not from today: the time and the date", () => {
    expect(rateNote(stale, new Date(2026, 10, 6, 2, 0).getTime())).toBe(`Price as of ${time} on ${day}`);
  });

  it("the same clock time a year apart is not today", () => {
    expect(rateNote(stale, new Date(2027, 10, 5, 23, 55).getTime())).toBe(`Price as of ${time} on ${day}`);
  });
});
