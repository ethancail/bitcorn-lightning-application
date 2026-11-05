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
