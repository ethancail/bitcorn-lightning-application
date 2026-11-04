// R17(5), as the arc chat reads it: the hub-channel tiebreak is the lowest
// short channel ID in NUMERIC order — block, then transaction, then output —
// never text order. Every pair below sorts the OTHER way as text.

import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

// hubChannel.ts imports the db module, which opens DB_DIR on load.
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-hub-channel-unit-"));
const { compareShortChannelIds, parseShortChannelId } = await import("./hubChannel");

describe("compareShortChannelIds — numeric, never text", () => {
  const pairs: Array<[lower: string, higher: string, why: string]> = [
    ["99x5x0", "100x1x0", "block 99 < block 100"],
    ["500x9x0", "500x10x0", "same block, tx 9 < tx 10"],
    ["500x1x9", "500x1x10", "same block and tx, output 9 < output 10"],
  ];

  for (const [lower, higher, why] of pairs) {
    it(`${lower} before ${higher} (${why}), though text order says the reverse`, () => {
      expect(higher < lower, "fixture: text order must disagree").toBe(true);
      expect(compareShortChannelIds(lower, higher)).toBeLessThan(0);
      expect(compareShortChannelIds(higher, lower)).toBeGreaterThan(0);
      expect([higher, lower].sort(compareShortChannelIds)).toEqual([lower, higher]);
    });
  }

  it("equal IDs compare equal", () => {
    expect(compareShortChannelIds("700000x5x1", "700000x5x1")).toBe(0);
  });

  it("parses the BLOCKxTXxOUTPUT form; anything else is null", () => {
    expect(parseShortChannelId("800000x1x0")).toEqual([800000, 1, 0]);
    expect(parseShortChannelId("880193788638019584")).toBeNull();
  });
});
