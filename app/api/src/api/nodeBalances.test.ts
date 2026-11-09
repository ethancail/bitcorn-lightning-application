// Drive-mode P3: /api/node/balances reports the local balance of inactive
// channels beside the active total, and leaves the active total (which the
// treasury dashboard's total_sats reads) exactly as it was.
//
// Harness: real migrations on a temp-dir DB.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-node-balances-"));
const { db } = await import("../db");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { nodeLightningBalances } = await import("./nodeBalances");

function channel(id: string, local: number, active: 0 | 1) {
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, "02" + "a".repeat(64), 1_000_000, local, 1_000_000 - local, active, Date.now());
}

beforeEach(() => {
  db.prepare("DELETE FROM lnd_channels").run();
});

describe("nodeLightningBalances", () => {
  it("splits active and inactive local balances", () => {
    channel("100x1x0", 300_000, 1);
    channel("200x1x0", 120_000, 0);
    channel("300x1x0", 5_000, 0);
    expect(nodeLightningBalances()).toEqual({ lightning_sats: 300_000, lightning_inactive_sats: 125_000 });
  });

  it("no channels: both zero", () => {
    expect(nodeLightningBalances()).toEqual({ lightning_sats: 0, lightning_inactive_sats: 0 });
  });

  it("only an inactive channel: the active total is still 0 (the treasury's total_sats is unchanged)", () => {
    channel("200x1x0", 640_000, 0);
    expect(nodeLightningBalances()).toEqual({ lightning_sats: 0, lightning_inactive_sats: 640_000 });
  });
});
