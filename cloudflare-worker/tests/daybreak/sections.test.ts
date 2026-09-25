// The Daybreak section-key contract validator (src/daybreak/sections.ts) — spec
// §3.4.4 first tests 51 and 52, at the unit level. The route-level halves (a
// 400 naming the field, nothing written) are in tests/daybreakDraftRoute.test.ts.
//
// The contract is the member screen's reading (§3.4.3, "AS BUILT";
// app/web/src/daybreak/daybreakView.ts), NOT the opaque-layer fixtures — three
// of which disagree with it on purpose (§3.4.4, Correction B). Every rejection
// is asserted with toEqual, so a rejection carrying anything beyond its code and
// field — free text, a value, a detail — fails here.

import { describe, expect, it } from "vitest";
import { SECTION_KEYS, validateSections } from "../../src/daybreak/sections";

/** Exactly the five contract keys, each in its contract shape. */
const CONFORMING = {
  lead: "Corn opened flat; the ratio did not.",
  kevinsRead: "First paragraph.\n\nSecond paragraph.",
  insideAgriculture: "A grain buyer in central Iowa said basis is widening.",
  worthReading: { title: "A report worth your time", note: "Why it matters.", link: "https://example.com/report" },
  closer: "Stack sats, plant corn.",
};

const with_ = (patch: Record<string, unknown>) => ({ ...CONFORMING, ...patch });
const withWorthReading = (patch: Record<string, unknown>) => with_({ worthReading: { ...CONFORMING.worthReading, ...patch } });

describe("test 51: sections are validated against the contract", () => {
  it("permitting: exactly the five contract keys, in their contract shapes, are accepted", () => {
    expect(SECTION_KEYS).toEqual(["lead", "kevinsRead", "insideAgriculture", "worthReading", "closer"]);
    expect(Object.keys(CONFORMING)).toEqual([...SECTION_KEYS]);
    expect(validateSections(CONFORMING)).toEqual({ ok: true });
  });

  it("permitting: every key is optional — a subset, and no sections at all, are accepted", () => {
    expect(validateSections({ lead: "Only the lead." })).toEqual({ ok: true });
    expect(validateSections({ lead: "x", closer: "y" })).toEqual({ ok: true });
    expect(validateSections({})).toEqual({ ok: true });
  });

  it("forbidding: an unknown key is rejected, naming the key itself", () => {
    expect(validateSections(with_({ headline: "a fixture key, not a contract key" }))).toEqual({
      ok: false,
      code: "unknown_section",
      field: "headline",
    });
    // anti-vacuity: the same payload without it is accepted
    expect(validateSections(CONFORMING)).toEqual({ ok: true });
  });

  it("forbidding: the reserved workerOwned key is rejected like any unknown key", () => {
    const supplied = with_({ workerOwned: { z: { status: "available", value: -9.99 } } });
    expect(validateSections(supplied)).toEqual({ ok: false, code: "unknown_section", field: "workerOwned" });
  });

  it("forbidding: a Z under any other key is rejected (the case Correction A found)", () => {
    expect(validateSections(with_({ z: { status: "available", value: 1.23 } }))).toEqual({
      ok: false,
      code: "unknown_section",
      field: "z",
    });
    expect(validateSections(with_({ zScore: 1.23 }))).toEqual({ ok: false, code: "unknown_section", field: "zScore" });
  });

  it("forbidding: wrong shapes — Worth Reading as an array, Kevin's Read as an object", () => {
    expect(validateSections(with_({ worthReading: ["one", "two"] }))).toEqual({
      ok: false,
      code: "invalid_section",
      field: "worthReading",
    });
    expect(validateSections(with_({ kevinsRead: { paragraphs: ["One.", "Two."], emphasis: true } }))).toEqual({
      ok: false,
      code: "invalid_section",
      field: "kevinsRead",
    });
    // anti-vacuity: the conforming payload, with that one field fixed, is accepted
    expect(validateSections(with_({ worthReading: CONFORMING.worthReading }))).toEqual({ ok: true });
    expect(validateSections(with_({ kevinsRead: "One.\n\nTwo." }))).toEqual({ ok: true });
  });

  it("forbidding: each text section must be a string", () => {
    for (const key of ["lead", "kevinsRead", "insideAgriculture", "closer"] as const) {
      for (const bad of [null, 42, true, ["a"], { text: "a" }]) {
        expect(validateSections(with_({ [key]: bad })), `${key} = ${JSON.stringify(bad)}`).toEqual({
          ok: false,
          code: "invalid_section",
          field: key,
        });
      }
    }
  });

  it("forbidding: Worth Reading needs a string title and note; an unknown member is rejected by name", () => {
    expect(validateSections(withWorthReading({ title: 7 }))).toEqual({ ok: false, code: "invalid_section", field: "worthReading.title" });
    expect(validateSections(withWorthReading({ note: ["a"] }))).toEqual({ ok: false, code: "invalid_section", field: "worthReading.note" });
    const { title: _t, ...noTitle } = CONFORMING.worthReading;
    expect(validateSections(with_({ worthReading: noTitle }))).toEqual({ ok: false, code: "invalid_section", field: "worthReading.title" });
    const { note: _n, ...noNote } = CONFORMING.worthReading;
    expect(validateSections(with_({ worthReading: noNote }))).toEqual({ ok: false, code: "invalid_section", field: "worthReading.note" });
    expect(validateSections(withWorthReading({ image: "https://example.com/x.png" }))).toEqual({
      ok: false,
      code: "unknown_section",
      field: "worthReading.image",
    });
    expect(validateSections(with_({ worthReading: null }))).toEqual({ ok: false, code: "invalid_section", field: "worthReading" });
  });

  it("forbidding: sections that are not a JSON object are rejected with no field", () => {
    for (const bad of [undefined, null, "lead", 3, ["lead"]]) {
      expect(validateSections(bad), JSON.stringify(bad)).toEqual({ ok: false, code: "invalid_sections" });
    }
  });

  it("the field is only ever a contract name or the rejected key — never a value or free text", () => {
    const hostile = with_({ "<b>not a key</b>": "<script>" });
    const r = validateSections(hostile);
    expect(r).toEqual({ ok: false, code: "unknown_section", field: "<b>not a key</b>" });
    expect(JSON.stringify(r)).not.toContain("<script>"); // the VALUE never appears
    expect(JSON.stringify(hostile)).toContain("<script>"); // anti-vacuity: it was there to leak
  });
});

describe("test 52: a non-https Worth Reading link is rejected", () => {
  it("permitting: an absolute https: link is accepted", () => {
    expect(validateSections(withWorthReading({ link: "https://example.com/a?b=c#d" }))).toEqual({ ok: true });
    expect(validateSections(withWorthReading({ link: "HTTPS://EXAMPLE.COM/" }))).toEqual({ ok: true }); // scheme is case-insensitive
  });

  it("forbidding: http:, javascript:, data:, a relative link, a missing link and a non-string are each rejected, naming the field", () => {
    const rejected = { ok: false, code: "invalid_link", field: "worthReading.link" };
    for (const link of [
      "http://example.com/report",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "/relative/path",
      "example.com/report",
      "//example.com/protocol-relative",
      "",
      42,
    ]) {
      expect(validateSections(withWorthReading({ link })), String(link)).toEqual(rejected);
    }
    const { link: _l, ...noLink } = CONFORMING.worthReading;
    expect(validateSections(with_({ worthReading: noLink }))).toEqual(rejected);
  });
});
