// FIXTURE — exists only for vitestRunGuards.test.ts. DO NOT EDIT.
//
// vitestRunGuards.test.ts spawns a real `vitest run` on this file and asserts
// its exact printed counts ("Tests 3 passed (3)", "Tests 3 skipped (3)"), so
// adding, removing or skipping a test here breaks those guards. It used to
// borrow src/shellGrid.test.ts, and broke when another change added a test
// there. Keep it tiny, pure and free of I/O; it also runs in the normal suite.

import { describe, expect, it } from "vitest";

describe("vitestRunGuards fixture", () => {
  it("fixture test 1", () => {
    expect(1 + 1).toBe(2);
  });
  it("fixture test 2", () => {
    expect("a".repeat(2)).toBe("aa");
  });
  it("fixture test 3", () => {
    expect([1, 2, 3].length).toBe(3);
  });
});
