// Drive-mode P1 (spec P1 items 2 and 8; migrations 064–069): the sync loop
// stores each channel's reserves, commitment fee, commitment type and in-flight
// HTLC totals, so capacity is computed from lnd's real constraints rather than
// the 1% stand-in, and Top Up can count anchor channels.
//
// The real persistChannels runs against a temp-dir database the real migration
// runner builds; only getLndChannels is stubbed, with fields shaped as
// ln-service's rpc_channel_as_channel returns them.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-persist-capacity-test-"));

const channels: any[] = [];
vi.mock("./lnd", () => ({
  getLndChannels: vi.fn(async () => ({ channels })),
  getLndPeers: vi.fn(async () => ({ peers: [] })),
}));

let persistChannels: typeof import("./persist-channels").persistChannels;
let db: typeof import("../db").db;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ persistChannels } = await import("./persist-channels"));
});

function lndChannel(over: Record<string, unknown>) {
  return {
    id: "800000x1x0",
    partner_public_key: "02" + "aa".repeat(32),
    capacity: 1_000_000,
    local_balance: 600_000,
    remote_balance: 389_000,
    is_active: true,
    is_private: false,
    local_reserve: 10_000,
    remote_reserve: 10_000,
    commit_transaction_fee: 2_810,
    type: "anchor",
    pending_payments: [],
    ...over,
  };
}

describe("persistChannels stores the capacity parts (migrations 064–069)", () => {
  it("writes reserves, commit fee, commitment type and in-flight totals by direction", async () => {
    channels.splice(0, channels.length, lndChannel({
      local_reserve: 12_345,
      remote_reserve: 9_876,
      commit_transaction_fee: 3_000,
      type: "simplified_taproot",
      pending_payments: [
        { id: "a", is_outgoing: true, tokens: 1_000 },
        { id: "b", is_outgoing: true, tokens: 2_500 },
        { id: "c", is_outgoing: false, tokens: 700 },
      ],
    }));
    await persistChannels();
    const row = db.prepare("SELECT * FROM lnd_channels WHERE channel_id = '800000x1x0'").get() as any;
    expect(row).toMatchObject({
      local_reserve_sat: 12_345,
      remote_reserve_sat: 9_876,
      commit_fee_sat: 3_000,
      commitment_type: "simplified_taproot",
      pending_outgoing_sat: 3_500,
      pending_incoming_sat: 700,
    });
  });

  it("updates the parts on the next sync tick (ON CONFLICT path)", async () => {
    channels.splice(0, channels.length, lndChannel({
      local_reserve: 20_000,
      remote_reserve: 15_000,
      commit_transaction_fee: 1_111,
      type: "anchor",
      pending_payments: [],
    }));
    await persistChannels();
    const row = db.prepare("SELECT * FROM lnd_channels WHERE channel_id = '800000x1x0'").get() as any;
    expect(row).toMatchObject({
      local_reserve_sat: 20_000,
      remote_reserve_sat: 15_000,
      commit_fee_sat: 1_111,
      commitment_type: "anchor",
      pending_outgoing_sat: 0,
      pending_incoming_sat: 0,
    });
  });
});

describe("persistChannels stores who opened the channel (migration 070, R23(i))", () => {
  const stored = async (over: Record<string, unknown>) => {
    channels.splice(0, channels.length, lndChannel(over));
    await persistChannels();
    return (db.prepare("SELECT is_initiator FROM lnd_channels WHERE channel_id = '800000x1x0'").get() as any).is_initiator;
  };

  it("we opened it (is_partner_initiated false) → 1; the peer did → 0, on the update path too", async () => {
    expect(await stored({ is_partner_initiated: false })).toBe(1);
    expect(await stored({ is_partner_initiated: true })).toBe(0);
  });

  it("not reported → NULL (capacity.ts then treats it as the funder)", async () => {
    expect(await stored({ is_partner_initiated: undefined })).toBeNull();
  });
});
