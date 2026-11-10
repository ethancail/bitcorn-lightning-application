// Drive-mode P3 (R39; plan item 5, sync.ts): membership_status follows the hub
// rule. Before, sync took the FIRST treasury channel lnd listed, with no
// active filter, so a member whose inactive channel happened to be listed
// before an active one was "treasury_channel_inactive" — and
// assertActiveMember refused every swap they tried.
//
// Harness: a real temp-dir DB for the hub rule; lnd and the persist steps are
// stubbed, persistChannels writing the scenario's rows as the real one would.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-sync-membership-"));
const TREASURY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = TREASURY;
const OTHER = "03" + "ab".repeat(32);

type Ch = { id: string; peer: string; capacity: number; active: boolean };
const scene = vi.hoisted(() => ({ channels: [] as Array<{ id: string; peer: string; capacity: number; active: boolean }>, status: [] as string[] }));

vi.mock("./lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lnd")>();
  return {
    ...actual,
    isLndAvailable: () => true,
    getLndInfo: async () => ({ public_key: "02" + "11".repeat(32), synced_to_chain: true }),
    getLndChannels: async () => ({
      channels: scene.channels.map((c) => ({ id: c.id, partner_public_key: c.peer, capacity: c.capacity, is_active: c.active })),
    }),
  };
});
vi.mock("./persist", () => ({ persistNodeInfo: vi.fn(async (_has: boolean, status: string) => { scene.status.push(status); }) }));
vi.mock("./persist-channels", async () => {
  const { db } = await import("../db");
  return {
    persistPeers: vi.fn(async () => {}),
    persistChannels: vi.fn(async () => {
      db.prepare("DELETE FROM lnd_channels").run();
      for (const c of scene.channels) {
        db.prepare(`
          INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `).run(c.id, c.peer, c.capacity, c.capacity / 2, c.capacity / 2, c.active ? 1 : 0, Date.now());
      }
    }),
  };
});
vi.mock("./persist-inbound", () => ({ syncInboundPayments: vi.fn(async () => {}) }));
vi.mock("./persist-forwarded", () => ({ syncForwardingHistory: vi.fn(async () => {}) }));
vi.mock("./network-payments", () => ({ syncNetworkInvoiceSettlements: vi.fn() }));

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { syncLndState } = await import("./sync");

async function statusFor(channels: Ch[]): Promise<string> {
  scene.channels = channels;
  scene.status = [];
  await syncLndState();
  return scene.status[0];
}

beforeEach(() => { scene.channels = []; });

describe("membership_status follows the hub rule", () => {
  it("an inactive treasury channel listed FIRST, an active one second → active_member", async () => {
    expect(await statusFor([
      { id: "700000x1x0", peer: TREASURY, capacity: 500_000, active: false },
      { id: "800000x1x0", peer: TREASURY, capacity: 400_000, active: true },
    ])).toBe("active_member");
  });

  it("every treasury channel inactive → treasury_channel_inactive", async () => {
    expect(await statusFor([
      { id: "700000x1x0", peer: TREASURY, capacity: 500_000, active: false },
    ])).toBe("treasury_channel_inactive");
  });

  it("only a channel to someone else → no_treasury_channel", async () => {
    expect(await statusFor([{ id: "700000x1x0", peer: OTHER, capacity: 500_000, active: true }])).toBe("no_treasury_channel");
  });

  it("an active channel to someone else does not make an inactive treasury channel count", async () => {
    expect(await statusFor([
      { id: "700000x1x0", peer: OTHER, capacity: 900_000, active: true },
      { id: "800000x1x0", peer: TREASURY, capacity: 500_000, active: false },
    ])).toBe("treasury_channel_inactive");
  });
});
