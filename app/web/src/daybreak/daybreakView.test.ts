// Pure view logic for the Daybreak member screen — spec §3.4.3 (bitcorn-
// research, specs/2026-09-21-bitcorn-daybreak-spec.md), first tests 38, 41, 42
// and 44 at the function level. The render-level halves live in
// ../pages/Daybreak.test.tsx.
//
// Every band table here is a TEST FIXTURE. The web app holds no band table of
// its own (test 46, ./noBandTable.test.ts); these exist only to be rendered.

import { afterEach, describe, expect, it } from "vitest";
import {
  bandTone,
  centreIndex,
  formatCentralDate,
  httpsHref,
  paragraphs,
  parseDaybreakRead,
  TONE_COLOUR,
  type Band,
} from "./daybreakView";

const ORIGINAL: Band[] = [
  { lower: null, upper: -1, label: "Fixture A" },
  { lower: -1, upper: -0.25, label: "Fixture B" },
  { lower: -0.25, upper: 0.25, label: "Fixture C" },
  { lower: 0.25, upper: 1, label: "Fixture D" },
  { lower: 1, upper: null, label: "Fixture E" },
];

// Shifted: four bands, and zero now sits in index 1, not 2.
const RECALIBRATED: Band[] = [
  { lower: null, upper: -2, label: "Recal P" },
  { lower: -2, upper: 0.5, label: "Recal Q" },
  { lower: 0.5, upper: 3, label: "Recal R" },
  { lower: 3, upper: null, label: "Recal S" },
];

const tones = (t: Band[]) => t.map((_, i) => bandTone(i, centreIndex(t)));

// ─── Test 38: colour by position ───────────────────────────────────────────

describe("test 38: colour by POSITION — the band holding 0 is amber, lower green, higher blue", () => {
  it("permitting: the original table", () => {
    expect(centreIndex(ORIGINAL)).toBe(2);
    expect(tones(ORIGINAL)).toEqual(["below", "below", "centre", "above", "above"]);
    expect(tones(ORIGINAL).map((t) => TONE_COLOUR[t])).toEqual([
      "var(--green)", "var(--green)", "var(--amber)", "var(--blue)", "var(--blue)",
    ]);
  });

  it("permitting: a RECALIBRATED table moves the centre with zero, not with the index", () => {
    expect(centreIndex(RECALIBRATED)).toBe(1);
    expect(tones(RECALIBRATED).map((t) => TONE_COLOUR[t])).toEqual([
      "var(--green)", "var(--amber)", "var(--blue)", "var(--blue)",
    ]);
  });

  it("zero on a boundary belongs to the band ABOVE it (lower bound inclusive)", () => {
    const t: Band[] = [
      { lower: null, upper: 0, label: "x" },
      { lower: 0, upper: null, label: "y" },
    ];
    expect(centreIndex(t)).toBe(1);
  });

  it("forbidding: no tone is red, in either table", () => {
    const all = [...tones(ORIGINAL), ...tones(RECALIBRATED)].map((t) => TONE_COLOUR[t]);
    expect(all.some((c) => /red/.test(c))).toBe(false);
    expect(Object.values(TONE_COLOUR).some((c) => /red/.test(c))).toBe(false);
    expect(all).toContain("var(--amber)"); // anti-vacuity: the scan sees real colours
  });

  it("forbidding: no colour follows a label — the same label takes its colour from where it sits", () => {
    const atCentre: Band[] = [
      { lower: null, upper: -1, label: "Low" },
      { lower: -1, upper: 1, label: "Same label" },
      { lower: 1, upper: null, label: "High" },
    ];
    const belowCentre: Band[] = [
      { lower: null, upper: -1, label: "Same label" },
      { lower: -1, upper: 1, label: "Mid" },
      { lower: 1, upper: null, label: "High" },
    ];
    const colourOf = (t: Band[], label: string) => TONE_COLOUR[bandTone(t.findIndex((b) => b.label === label), centreIndex(t))];
    expect(colourOf(atCentre, "Same label")).toBe("var(--amber)");
    expect(colourOf(belowCentre, "Same label")).toBe("var(--green)");
  });
});

// ─── Test 41: paragraphs ───────────────────────────────────────────────────

describe("test 41 (function level): sections split into paragraphs on blank lines", () => {
  it("permitting: blank lines split; markup characters are kept literally as text", () => {
    expect(paragraphs("First <b>x</b>.\n\nSecond.\n  \nThird")).toEqual(["First <b>x</b>.", "Second.", "Third"]);
  });

  it("a single newline does not split a paragraph", () => {
    expect(paragraphs("line one\nline two")).toEqual(["line one\nline two"]);
  });

  it("forbidding: whitespace-only text yields no paragraphs (the section is not rendered)", () => {
    expect(paragraphs("  \n\n \t")).toEqual([]);
    expect(paragraphs("x")).toEqual(["x"]); // anti-vacuity
  });
});

// ─── Test 42: https only ───────────────────────────────────────────────────

describe("test 42 (function level): a link is a link only if its scheme is https", () => {
  it("permitting: an https: URL is returned", () => {
    expect(httpsHref("https://example.com/read?x=1")).toBe("https://example.com/read?x=1");
  });

  for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,<b>x</b>", "/relative/path", "example.com", "", "ftp://example.com"]) {
    it(`forbidding: ${JSON.stringify(bad)} is not a link`, () => {
      expect(httpsHref(bad)).toBeUndefined();
    });
  }

  it("forbidding: a non-string is not a link", () => {
    expect(httpsHref(42)).toBeUndefined();
    expect(httpsHref({ href: "https://example.com" })).toBeUndefined();
  });
});

// ─── Test 44: calendar dates are never converted ───────────────────────────

describe("test 44 (function level): a Central calendar date renders as its own day in every zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  for (const zone of ["America/Chicago", "America/New_York", "Pacific/Honolulu", "Asia/Tokyo"]) {
    it(`${zone}: 2026-09-29 shows the 29th, never the 28th or the 30th`, () => {
      process.env.TZ = zone;
      const text = formatCentralDate("2026-09-29");
      expect(text).toMatch(/\b29\b/);
      expect(text).not.toMatch(/\b28\b/);
      expect(text).not.toMatch(/\b30\b/);
    });
  }

  it("anti-vacuity: the zone switch is live — a local-time render of UTC midnight really is the 28th in Chicago", () => {
    process.env.TZ = "America/Chicago";
    expect(new Date("2026-09-29T00:00:00Z").getDate()).toBe(28);
  });
});

// ─── The response parser ───────────────────────────────────────────────────

describe("parseDaybreakRead", () => {
  const edition = (z: unknown, extra: Record<string, unknown> = {}) => ({
    state: "current",
    dueDate: "2026-09-29",
    edition: { date: "2026-09-29", content: { lead: "Lead text", ...extra, workerOwned: { z } } },
  });
  const zAvail = {
    status: "available",
    value: -0.42,
    corn: { date: "2026-09-28", close: 4.1, fetchedAt: "x" },
    btc: { date: "2026-09-28", close: 60000, fetchedAt: "x" },
    bands: { status: "available", table: ORIGINAL, index: 1 },
  };

  it("permitting: a current edition with stamped bands", () => {
    const r = parseDaybreakRead(edition(zAvail));
    expect(r).toMatchObject({ state: "current", date: "2026-09-29", z: { status: "available", value: -0.42, bands: { status: "available", index: 1 } } });
  });

  it("the no-edition state", () => {
    expect(parseDaybreakRead({ state: "unavailable" })).toEqual({ state: "unavailable" });
  });

  it("forbidding: a shape it does not recognise is null — never a guessed edition", () => {
    for (const bad of [null, "text", { state: "bogus" }, { state: "current" }, { state: "current", edition: { date: 5, content: {} } }]) {
      expect(parseDaybreakRead(bad)).toBeNull();
    }
  });

  it("unknown section keys are ignored; non-string sections are not rendered", () => {
    const r = parseDaybreakRead(edition(zAvail, { mystery: "should not appear", kevinsRead: { paragraphs: ["x"] } }));
    expect(r && "sections" in r ? r.sections : null).toEqual({ lead: ["Lead text"] });
  });

  it("stamped bands that are not a usable table are treated as unavailable, never guessed", () => {
    const r = parseDaybreakRead(edition({ ...zAvail, bands: { status: "available", table: "nope", index: 0 } }));
    expect(r && "z" in r && r.z.status === "available" ? r.z.bands.status : null).toBe("unavailable");
  });
});
