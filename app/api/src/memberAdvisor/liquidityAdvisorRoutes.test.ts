// SH9: GET /api/liquidity/status returns the member's DECLARED role whether
// or not the treasury channel is active.
//
// classifyTreasuryChannel() reads only an ACTIVE channel (lnd_channels.active
// = 1), so while that channel is inactive `classification` is null — and the
// role, which lived only inside it, vanished with it. The response now
// carries the stored role at the top level.
//
// The schema is the real migrations' (002, 027, 028, 032), run into an
// in-memory database; only the treasury pubkey and the Loop probe are stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TREASURY = "02" + "c".repeat(64);

const mem = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  return new Database(":memory:");
});

for (const m of ["002_channels.sql", "027_member_liquidity_advisor.sql", "028_advisor_min_channel_capacity.sql", "032_channel_role.sql"]) {
  mem.exec(readFileSync(join(__dirname, "..", "db", "migrations", m), "utf8"));
}

vi.mock("../db", () => ({ db: mem }));
vi.mock("../config/env", () => ({ ENV: { treasuryPubkey: "02" + "c".repeat(64) } }));
vi.mock("./loopAvailability", () => ({
  checkLoopAvailability: async () => ({
    loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false,
    loopOutTerms: null, loopInTerms: null,
  }),
}));

const { getLiquidityStatus } = await import("./liquidityAdvisorRoutes");

function declare(role: "merchant" | "farmer" | "unknown") {
  mem.prepare("UPDATE member_liquidity_advisor_config SET channel_role = ? WHERE id = 1").run(role);
}

function treasuryChannel(active: 0 | 1) {
  mem.prepare("DELETE FROM lnd_channels").run();
  mem.prepare(
    `INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
     VALUES ('100x1x0', ?, 1000000, 500000, 500000, ?, 0, 0)`,
  ).run(TREASURY, active);
}

beforeEach(() => declare("unknown"));

describe("SH9: the declared role is returned whether or not the channel is active", () => {
  it("PERMITTING: active channel, role merchant — the role is there, matching classification", async () => {
    declare("merchant");
    treasuryChannel(1);
    const s = await getLiquidityStatus();
    expect(s.classification?.channelRole).toBe("merchant");
    expect(s.channelRole).toBe("merchant");
  });

  it("INACTIVE channel, role merchant — classification is null, the role still comes back", async () => {
    declare("merchant");
    treasuryChannel(0);
    const s = await getLiquidityStatus();
    expect(s.classification).toBeNull();
    expect(s.channelRole).toBe("merchant");
  });

  it("no channel at all, role farmer — the role still comes back", async () => {
    declare("farmer");
    mem.prepare("DELETE FROM lnd_channels").run();
    expect((await getLiquidityStatus()).channelRole).toBe("farmer");
  });

  it("nothing declared — 'unknown', not a guessed role", async () => {
    treasuryChannel(0);
    expect((await getLiquidityStatus()).channelRole).toBe("unknown");
  });
});
