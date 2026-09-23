// Pure date functions for Daybreak editions (src/daybreak/dates.ts).
//
// Numbered tests refer to the Daybreak spec's first-tests list (§3.3). Each
// has a PERMITTING case (the right thing IS there) and a FORBIDDING case (the
// wrong thing never is), per the spec's §5.1 / §5.2.
//
// ⚠ An unpinned local workerd inherits the HOST's timezone (on a Chicago
// machine, `new Date(x).getDate()` answers in CDT), while production Workers run
// in UTC — so a local-getter bug could pass here and fail there. vitest.config.ts
// pins the pool to UTC to close that; independently, these assertions compare
// against exact UTC instants and Intl output with an explicit zone, never
// against local getters.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAYBREAK_CALENDAR,
  centralDateOf,
  classifyEdition,
  dueInstant,
  isCentralDate,
  isDueDay,
  mostRecentDueDate,
  type DaybreakCalendar,
} from "../../src/daybreak/dates";

const at = (iso: string) => new Date(iso);

function chicagoWallClock(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute}`;
}

describe("centralDateOf — test 3: an evening read in Central after UTC midnight", () => {
  it("20:00 CDT Tue 2026-09-22 (01:00Z Wed) is 2026-09-22 — never the UTC date 2026-09-23", () => {
    const got = centralDateOf(at("2026-09-23T01:00:00Z"));
    expect(got).toBe("2026-09-22"); // permitting
    expect(got).not.toBe("2026-09-23"); // forbidding: the UTC date
  });

  it("23:59 CDT is still the same Central date; 00:00 CDT is the next", () => {
    expect(centralDateOf(at("2026-09-23T04:59:00Z"))).toBe("2026-09-22");
    expect(centralDateOf(at("2026-09-23T05:00:00Z"))).toBe("2026-09-23");
  });
});

describe("centralDateOf — test 6: reads across both daylight-saving transitions", () => {
  // Spring forward: Sun 2026-03-08, 02:00 CST → 03:00 CDT at 08:00Z.
  // Fall back:      Sun 2026-11-01, 02:00 CDT → 01:00 CST at 07:00Z.
  const cases: Array<[string, string, string]> = [
    ["2026-03-08T05:59:00Z", "2026-03-07", "23:59 CST, eve of spring-forward"],
    ["2026-03-08T06:00:00Z", "2026-03-08", "00:00 CST, spring-forward day begins"],
    ["2026-03-08T07:59:00Z", "2026-03-08", "01:59 CST, one minute before the jump"],
    ["2026-03-08T08:00:00Z", "2026-03-08", "03:00 CDT, just after the jump"],
    ["2026-03-09T04:59:00Z", "2026-03-08", "23:59 CDT, spring-forward day ends"],
    ["2026-03-09T05:00:00Z", "2026-03-09", "00:00 CDT, next day"],
    ["2026-11-01T04:59:00Z", "2026-10-31", "23:59 CDT, eve of fall-back"],
    ["2026-11-01T05:00:00Z", "2026-11-01", "00:00 CDT, fall-back day begins"],
    ["2026-11-01T06:30:00Z", "2026-11-01", "first 01:30 (CDT)"],
    ["2026-11-01T07:30:00Z", "2026-11-01", "second 01:30 (CST)"],
    ["2026-11-02T05:59:00Z", "2026-11-01", "23:59 CST, fall-back day ends"],
    ["2026-11-02T06:00:00Z", "2026-11-02", "00:00 CST, next day"],
  ];
  for (const [iso, want, label] of cases) {
    it(`${iso} (${label}) → ${want}`, () => {
      const got = centralDateOf(at(iso));
      expect(got).toBe(want); // permitting
      // forbidding: never the adjacent day on either side
      const [y, m, d] = want.split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
      const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      expect(got).not.toBe(prev);
      expect(got).not.toBe(next);
    });
  }
});

describe("dueInstant — 6:00 AM Central on the date, as a UTC instant, DST-correct", () => {
  const cases: Array<[string, string]> = [
    ["2026-09-23", "2026-09-23T11:00:00.000Z"], // CDT
    ["2026-03-07", "2026-03-07T12:00:00.000Z"], // last CST morning
    ["2026-03-08", "2026-03-08T11:00:00.000Z"], // spring-forward day: 06:00 is already CDT
    ["2026-03-09", "2026-03-09T11:00:00.000Z"],
    ["2026-10-31", "2026-10-31T11:00:00.000Z"], // last CDT morning
    ["2026-11-01", "2026-11-01T12:00:00.000Z"], // fall-back day: 06:00 is already CST
    ["2026-11-02", "2026-11-02T12:00:00.000Z"],
    ["2026-01-15", "2026-01-15T12:00:00.000Z"], // mid-winter CST
  ];
  for (const [date, want] of cases) {
    it(`${date} → ${want}`, () => {
      const got = dueInstant(date);
      expect(got.toISOString()).toBe(want); // permitting: exact instant
      // forbidding: never off by the DST hour — it IS 06:00 on that Central date
      expect(chicagoWallClock(got)).toBe("06:00");
      expect(centralDateOf(got)).toBe(date);
    });
  }

  it("a malformed date is rejected, not coerced", () => {
    expect(() => dueInstant("2026-9-23")).toThrow();
    expect(() => dueInstant("2026-02-30")).toThrow();
    expect(dueInstant("2026-02-28").toISOString()).toBe("2026-02-28T12:00:00.000Z"); // anti-vacuity
  });
});

describe("isCentralDate — strict YYYY-MM-DD, real calendar dates only", () => {
  it("accepts real dates; rejects malformed and impossible ones", () => {
    expect(isCentralDate("2026-09-23")).toBe(true);
    expect(isCentralDate("2028-02-29")).toBe(true);
    for (const bad of [undefined, null, "", "2026-9-23", "2026-09-23T00:00", "2026-02-30", "2027-02-29", 20260923, new Date()]) {
      expect(isCentralDate(bad)).toBe(false);
    }
  });
});

describe("isDueDay — the calendar is a PARAMETER", () => {
  it("default calendar is Monday–Friday with no holidays", () => {
    expect(DEFAULT_DAYBREAK_CALENDAR.dueWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_DAYBREAK_CALENDAR.holidays).toEqual([]);
    expect(isDueDay("2026-09-21")).toBe(true); // Mon
    expect(isDueDay("2026-09-25")).toBe(true); // Fri
    expect(isDueDay("2026-09-26")).toBe(false); // Sat
    expect(isDueDay("2026-09-27")).toBe(false); // Sun
  });

  it("a different calendar changes the answer (Mon/Wed/Fri: Tuesday is NOT due; Saturday-only: Saturday IS)", () => {
    const mwf: DaybreakCalendar = { dueWeekdays: [1, 3, 5], holidays: [] };
    expect(isDueDay("2026-09-22", mwf)).toBe(false); // Tue — permitting under the passed calendar
    expect(isDueDay("2026-09-22")).toBe(true); // anti-vacuity: the default says due
    const sat: DaybreakCalendar = { dueWeekdays: [6], holidays: [] };
    expect(isDueDay("2026-09-26", sat)).toBe(true);
    expect(isDueDay("2026-09-25", sat)).toBe(false);
  });

  it("a holiday on a due weekday is not due", () => {
    const cal: DaybreakCalendar = { dueWeekdays: [1, 2, 3, 4, 5], holidays: ["2026-11-26"] };
    expect(isDueDay("2026-11-26", cal)).toBe(false); // Thanksgiving Thu
    expect(isDueDay("2026-11-26")).toBe(true); // anti-vacuity: default calendar
    expect(isDueDay("2026-11-27", cal)).toBe(true);
  });
});

describe("mostRecentDueDate — the most recent due instant at or before now", () => {
  it("test 7 shape: before 06:00 Central on a due day, the previous due day is the one expected", () => {
    expect(mostRecentDueDate(at("2026-09-23T10:59:59Z"))).toBe("2026-09-22"); // Wed 05:59:59 CDT
  });

  it("test 8 shape: at and after 06:00 Central on a due day, that day is expected", () => {
    expect(mostRecentDueDate(at("2026-09-23T11:00:00Z"))).toBe("2026-09-23"); // exactly 06:00 CDT
    expect(mostRecentDueDate(at("2026-09-23T12:00:00Z"))).toBe("2026-09-23");
  });

  it("test 3 shape: Tuesday evening after UTC midnight still expects Tuesday", () => {
    expect(mostRecentDueDate(at("2026-09-23T01:00:00Z"))).toBe("2026-09-22");
  });

  it("weekend and Monday pre-dawn expect Friday", () => {
    expect(mostRecentDueDate(at("2026-09-26T18:00:00Z"))).toBe("2026-09-25"); // Sat
    expect(mostRecentDueDate(at("2026-09-28T10:59:00Z"))).toBe("2026-09-25"); // Mon 05:59 CDT
    expect(mostRecentDueDate(at("2026-09-28T11:00:00Z"))).toBe("2026-09-28"); // Mon 06:00 CDT
  });

  it("test 6 shape: the first due mornings after each DST transition switch at 06:00 local", () => {
    // Mon 2026-03-09 is CDT: due at 11:00Z.
    expect(mostRecentDueDate(at("2026-03-09T10:59:00Z"))).toBe("2026-03-06");
    expect(mostRecentDueDate(at("2026-03-09T11:00:00Z"))).toBe("2026-03-09");
    // Mon 2026-11-02 is CST: due at 12:00Z — 11:00Z is still pre-dawn (05:00 CST).
    expect(mostRecentDueDate(at("2026-11-02T11:59:00Z"))).toBe("2026-10-30");
    expect(mostRecentDueDate(at("2026-11-02T12:00:00Z"))).toBe("2026-11-02");
  });

  it("uses the passed calendar: Mon/Wed/Fri on a Tuesday morning expects Monday", () => {
    const mwf: DaybreakCalendar = { dueWeekdays: [1, 3, 5], holidays: [] };
    expect(mostRecentDueDate(at("2026-09-22T12:00:00Z"), mwf)).toBe("2026-09-21");
    expect(mostRecentDueDate(at("2026-09-22T12:00:00Z"))).toBe("2026-09-22"); // anti-vacuity
  });

  it("is bounded: a calendar with no due days returns null instead of walking forever", () => {
    expect(mostRecentDueDate(at("2026-09-23T12:00:00Z"), { dueWeekdays: [], holidays: [] })).toBeNull();
    // bound is inclusive of today: with a 1-day window only today can qualify
    expect(mostRecentDueDate(at("2026-09-23T12:00:00Z"), DEFAULT_DAYBREAK_CALENDAR, 1)).toBe("2026-09-23");
    expect(mostRecentDueDate(at("2026-09-23T10:00:00Z"), DEFAULT_DAYBREAK_CALENDAR, 1)).toBeNull();
  });
});

describe("classifyEdition — decided by DATE COMPARISON", () => {
  it("latest dated ON the due date → current; BEFORE → held over; nothing → unavailable", () => {
    expect(classifyEdition({ dueDate: "2026-09-23", latestPublishedDate: "2026-09-23" })).toBe("current");
    expect(classifyEdition({ dueDate: "2026-09-23", latestPublishedDate: "2026-09-22" })).toBe("held_over");
    expect(classifyEdition({ dueDate: "2026-09-23", latestPublishedDate: null })).toBe("unavailable");
  });

  it("latest dated AFTER the due date (an off-calendar edition) → current, never held over", () => {
    expect(classifyEdition({ dueDate: "2026-09-25", latestPublishedDate: "2026-09-26" })).toBe("current"); // Sat after a missing Fri
    expect(classifyEdition({ dueDate: "2026-09-25", latestPublishedDate: "2026-09-24" })).toBe("held_over"); // anti-vacuity
  });

  it("compares in calendar order across month and year boundaries", () => {
    expect(classifyEdition({ dueDate: "2026-10-01", latestPublishedDate: "2026-09-30" })).toBe("held_over");
    expect(classifyEdition({ dueDate: "2026-12-31", latestPublishedDate: "2027-01-01" })).toBe("current");
  });

  it("no due date in the window → absence is never late → current", () => {
    expect(classifyEdition({ dueDate: null, latestPublishedDate: "2026-09-10" })).toBe("current");
    expect(classifyEdition({ dueDate: null, latestPublishedDate: null })).toBe("unavailable");
  });
});

describe("test 4: two reads at the same instant from different browser timezones", () => {
  // The same instant written as a Chicago and a New York wall clock. The
  // functions take an instant only — there is no zone argument to differ.
  const chicago = at("2026-09-23T06:30:00-05:00");
  const newYork = at("2026-09-23T07:30:00-04:00");

  it("both resolve to the same Central date and the same expected edition", () => {
    expect(chicago.getTime()).toBe(newYork.getTime());
    expect(centralDateOf(chicago)).toBe("2026-09-23"); // permitting
    expect(centralDateOf(newYork)).toBe(centralDateOf(chicago)); // forbidding: never differ
    expect(mostRecentDueDate(newYork)).toBe(mostRecentDueDate(chicago));
    expect(mostRecentDueDate(chicago)).toBe("2026-09-23");
  });
});
