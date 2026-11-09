// Drive-mode P3 (R40(2); R16(6), R17(3), R19(6), R21(1)): the advisor's
// "recommended minimum" is the one formula's live size, not 032's stored
// 1,000,000 (farmer) / 2,000,000 (merchant), which every node has seeded.
//   - a farmer at 500,000 is no longer undersized (at r5's price the Save on
//     fees size is 406,055)
//   - below the size, the advisor names it and suggests it
//   - the size follows the member's strategy; Manual only uses Save on fees'
//   - no rate: no size claim
//
// Harness: recommendationEngine.swapLimits.test.ts's (real migrations, temp-dir
// DB); the cached rate stubbed at mockup r5's $76,848.88.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-advisor-minimum-"));

const rate = vi.hoisted(() => ({ usd: 76_848.88 as number | null }));
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return { ...actual, getBtcUsd: () => ({ usd: rate.usd, source: "coinbase", fetched_at: 1, age_ms: 0, state: rate.usd == null ? "none" : "fresh" }) };
});

let computeRecommendation: typeof import("./recommendationEngine").computeRecommendation;
let db: any;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = (await import("../db")).db;
  ({ computeRecommendation } = await import("./recommendationEngine"));
});

beforeEach(() => {
  rate.usd = 76_848.88;
  db.prepare("DELETE FROM member_transfer_settings").run();
});

/** The classified channel, on an anchor channel with commit fee 872 (H = 1,409, C = 1,532). */
function c(over: Partial<ChannelClassification>): ChannelClassification {
  const capacitySat = over.capacitySat ?? 1_000_000;
  const memberLocalSat = over.memberLocalSat ?? Math.round(capacitySat / 2);
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, commit_fee_sat, commitment_type)
    VALUES ('1x1x1', ?, ?, ?, ?, 1, 0, ?, 872, 'anchor')
  `).run("02" + "b7".repeat(32), capacitySat, memberLocalSat, capacitySat - memberLocalSat, Date.now());
  return {
    channelId: "1x1x1", capacitySat, memberLocalSat,
    treasuryLocalSat: capacitySat - memberLocalSat, memberLocalPct: memberLocalSat / capacitySat,
    state: "healthy", urgency: "none", consecutiveNonHealthyRuns: 0, classifiedAt: 0,
    channelRole: "farmer", ...over,
  };
}

const LOOP: LoopAvailability = {
  loopDaemonRunning: true, loopOutAvailable: true, loopInAvailable: true,
  loopOutTerms: { minSats: 250_000, maxSats: 5_000_000 }, loopInTerms: { minSats: 100_000, maxSats: 5_000_000 },
  unavailableReason: null,
} as LoopAvailability;

describe("the advisor's minimum is the formula's", () => {
  it("032's seeded 1,000,000 / 2,000,000 are still in the row — and no longer read", () => {
    const row = db.prepare("SELECT farmer_recommended_capacity_sat AS f, merchant_recommended_capacity_sat AS m FROM member_liquidity_advisor_config WHERE id = 1").get();
    expect(row).toEqual({ f: 1_000_000, m: 2_000_000 });
  });

  it("a farmer at 500,000 is NOT undersized (Save on fees needs 406,055)", () => {
    const rec = computeRecommendation(c({ capacitySat: 500_000 }), LOOP);
    expect(rec.action).not.toBe("channel_upgrade");
  });

  it("a farmer at 400,000 is, and the advisor names and suggests 406,055", () => {
    const rec = computeRecommendation(c({ capacitySat: 400_000 }), LOOP);
    expect(rec.action).toBe("channel_upgrade");
    expect(rec.reason).toContain("minimum of 406,055 sats");
    expect(rec.suggestedAmountSats).toBe(406_055);
  });

  it("a merchant at 1,000,000 is NOT undersized (370,605, not 2,000,000)", () => {
    const rec = computeRecommendation(c({ channelRole: "merchant", capacitySat: 1_000_000 }), LOOP);
    expect(rec.action).not.toBe("channel_upgrade");
  });

  it("a merchant at 360,000 is, and the advisor names 370,605", () => {
    const rec = computeRecommendation(c({ channelRole: "merchant", capacitySat: 360_000 }), LOOP);
    expect(rec.action).toBe("channel_upgrade");
    expect(rec.reason).toContain("minimum of 370,605 sats");
    expect(rec.suggestedAmountSats).toBe(370_605);
  });

  it("R19(6): on Keep room open, the size is Keep room open's (499,002)", () => {
    db.prepare("INSERT INTO member_transfer_settings (id, strategy) VALUES (1, 'open')").run();
    const rec = computeRecommendation(c({ capacitySat: 450_000 }), LOOP);
    expect(rec.action).toBe("channel_upgrade");
    expect(rec.suggestedAmountSats).toBe(499_002);
  });

  it("R21(1): Manual only uses Save on fees' size", () => {
    db.prepare("INSERT INTO member_transfer_settings (id, strategy) VALUES (1, 'manual')").run();
    expect(computeRecommendation(c({ capacitySat: 400_000 }), LOOP).suggestedAmountSats).toBe(406_055);
  });

  it("no rate: no size claim", () => {
    rate.usd = null;
    expect(computeRecommendation(c({ capacitySat: 400_000 }), LOOP).action).not.toBe("channel_upgrade");
  });
});
