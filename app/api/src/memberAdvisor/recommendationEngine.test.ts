import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

// Stub the singleton db module so importing ./recommendationEngine (which
// imports ../db) doesn't try to mkdir /data/db on the test host — same
// pattern as base/store.test.ts.
vi.mock("../db", () => ({ db: new Database(":memory:") }));

import { describeSustainedRuns } from "./recommendationEngine";

// One scheduler run = 15 minutes (advisorScheduler.ts). The member-facing
// "repeated depletion/filling" copy renders this as a duration, never as
// "N consecutive runs" jargon.
describe("describeSustainedRuns", () => {
  it("renders minutes for short sustained states", () => {
    expect(describeSustainedRuns(1)).toBe("about 15 minutes");
    expect(describeSustainedRuns(3)).toBe("about 45 minutes"); // the >=3 escalation threshold
    expect(describeSustainedRuns(4)).toBe("about 60 minutes");
  });

  it("switches to hours past one hour", () => {
    expect(describeSustainedRuns(5)).toBe("about 1 hour");
    expect(describeSustainedRuns(8)).toBe("about 2 hours");
    expect(describeSustainedRuns(40)).toBe("about 10 hours");
  });

  it("caps at 'more than a day' — including legacy inflated counters", () => {
    expect(describeSustainedRuns(96)).toBe("more than a day");
    // pre-fix dev DBs accumulated counters like 51,588 from poll-driven
    // increments; the cap keeps those rows from rendering absurd durations
    expect(describeSustainedRuns(51_588)).toBe("more than a day");
  });
});
