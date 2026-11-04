// Drive-mode P1 item 6 (spec P1 item 6; finding 5): the advisor's suggested
// swap amounts are bounded by the EFFECTIVE limits — the stricter of loopd's
// terms and Bitcorn's env limits, per direction — not by raw loopd terms, so
// it never suggests an amount the member policy refuses. (recommendationEngine
// :72's minLoopSats is dead and left alone.)
//
// Env defaults: withdrawal minimum 250,000; refill maximum 3,000,000.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-advisor-swap-limits-"));

let computeRecommendation: typeof import("./recommendationEngine").computeRecommendation;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  // A max_loop_sats above the env refill maximum, so only the env bounds it.
  db.prepare("UPDATE member_liquidity_advisor_config SET max_loop_sats = 9000000 WHERE id = 1").run();
  ({ computeRecommendation } = await import("./recommendationEngine"));
});

function c(over: Partial<ChannelClassification>): ChannelClassification {
  const capacitySat = over.capacitySat ?? 1_000_000;
  const memberLocalSat = over.memberLocalSat ?? 500_000;
  return {
    channelId: "1x1x1", capacitySat, memberLocalSat,
    treasuryLocalSat: capacitySat - memberLocalSat, memberLocalPct: memberLocalSat / capacitySat,
    state: "healthy", urgency: "medium", consecutiveNonHealthyRuns: 0, classifiedAt: 0,
    channelRole: "unknown", ...over,
  };
}

function loopUp(out: { minSats: number; maxSats: number }, inn: { minSats: number; maxSats: number }): LoopAvailability {
  return {
    loopDaemonRunning: true, loopOutAvailable: true, loopInAvailable: true,
    loopOutTerms: out, loopInTerms: inn, unavailableReason: null,
  };
}

describe("the advisor's suggestions respect the stricter of terms and env", () => {
  it("farmer Loop Out: a 220,000 need with loopd's minimum at 100,000 suggests env's 250,000", () => {
    // capacity 1,000,000, local 720,000, target 50% → 220,000 to move.
    const r = computeRecommendation(
      c({ channelRole: "farmer", capacitySat: 1_000_000, memberLocalSat: 720_000, state: "send_heavy" }),
      loopUp({ minSats: 100_000, maxSats: 5_000_000 }, { minSats: 100_000, maxSats: 5_000_000 }),
    );
    expect(r.action).toBe("loop_out");
    expect(r.suggestedAmountSats).toBe(250_000);
  });

  it("merchant Loop In: a 4,600,000 need with loopd's maximum at 10,000,000 is capped at env's 3,000,000", () => {
    // capacity 10,000,000, local 400,000 (4%), target 50% → 4,600,000.
    const r = computeRecommendation(
      c({ channelRole: "merchant", capacitySat: 10_000_000, memberLocalSat: 400_000, state: "receive_exhausted" }),
      loopUp({ minSats: 100_000, maxSats: 10_000_000 }, { minSats: 100_000, maxSats: 10_000_000 }),
    );
    expect(r.action).toBe("loop_in");
    expect(r.suggestedAmountSats).toBe(3_000_000);
  });
});
