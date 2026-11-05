// Drive-mode P1 item 2 (spec P1 item 2, §3.3; D1.2, D1.3; R18(4)):
// one capacity computation —
//   room to send    = local_balance  − local_reserve
//   room to receive = remote_balance − remote_reserve
// read from lnd's real channel constraints (migrations 064/065), with
// in-flight HTLCs REPORTED as components and NOT subtracted (lnd's balances
// already exclude them) and the commitment fee reported only (already netted).
//
// The fixture's reserves are deliberately NOT 1% of capacity, so the old
// `Math.ceil(capacity * 0.01)` stand-in and the real reserve disagree, and
// room + 1 sat separates them.
//
// Harness: hubChannel.sites.test.ts's — real migrations on a temp-dir DB; only
// the LND boundary is stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-capacity-sites-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const OTHER = "03" + "cd".repeat(32);

const ln = vi.hoisted(() => ({
  decoded: { id: "bb".repeat(32), destination: "", tokens: 0, description: "t" } as any,
  payViaPaymentRequest: vi.fn(async (_args: any) => ({ id: "bb".repeat(32), tokens: 0, fee: 0, confirmed_at: "" })),
}));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    decodePaymentRequest: vi.fn(async () => ln.decoded),
    payViaPaymentRequest: ln.payViaPaymentRequest,
  };
});
vi.mock("./lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lnd")>();
  return {
    ...actual,
    getLndClient: () => ({ lnd: {} }),
    getLndPeers: async () => ({ peers: [{ public_key: HUB }] }),
    isKeysendEnabled: async () => true,
  };
});
vi.mock("../subscription/tier2Gate", () => ({ assertTier2RoutingAllowed: () => {} }));
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "member", membership_status: "active" }) };
});
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline in test"); }));

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { payNetworkInvoice } = await import("./network-payments");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

// capacity 1,000,000; the 1% stand-in would be 10,000 — the real reserves are not.
// Opened by the treasury (is_initiator 0): a non-funder's room is local − reserve
// (R23(i); the funder's headroom is in the last describe below).
const CH = {
  id: "800000x1x0", cap: 1_000_000, local: 600_000, remote: 389_000,
  localReserve: 30_000, remoteReserve: 25_000,
  pendingOut: 5_000, pendingIn: 2_000, commitFee: 2_810,
};
const ROOM_TO_SEND = CH.local - CH.localReserve;       // 570,000
const ROOM_TO_RECEIVE = CH.remote - CH.remoteReserve;  // 364,000

beforeEach(() => {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare("DELETE FROM network_payments").run();
  db.prepare(`
    INSERT INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
       active, private, updated_at, local_reserve_sat, remote_reserve_sat,
       commit_fee_sat, commitment_type, pending_outgoing_sat, pending_incoming_sat, is_initiator)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, 'anchor', ?, ?, 0)
  `).run(CH.id, HUB, CH.cap, CH.local, CH.remote, Date.now(), CH.localReserve,
    CH.remoteReserve, CH.commitFee, CH.pendingOut, CH.pendingIn);
});

async function pay(tokens: number, destination: string) {
  ln.decoded = { ...ln.decoded, destination, tokens };
  ln.payViaPaymentRequest.mockClear();
  const err = await payNetworkInvoice("lnbcrt1test").then(() => null, (e: Error) => e.message);
  return { err, payCalled: ln.payViaPaymentRequest.mock.calls.length > 0 };
}

async function statsChannel(): Promise<any> {
  let body = "";
  const res: any = { setHeader() {}, writeHead() { return res; }, end(c?: string) { if (c) body += c; return res; } };
  await handleRequest({ method: "GET", url: "/api/member/stats", headers: {} } as any, res);
  return JSON.parse(body).treasury_channel;
}

describe("D1.2 — the server's refusal point is room to send (local − local reserve)", () => {
  for (const [label, dest] of [["routed (treasury) branch", OTHER], ["direct-peer branch", HUB]] as const) {
    it(`${label}: exactly room to send is not refused for capacity; payInvoice is called`, async () => {
      const r = await pay(ROOM_TO_SEND, dest);
      expect(r.err).toBeNull();
      expect(r.payCalled).toBe(true);
    });

    it(`${label}: room to send + 1 is refused before payInvoice, naming the room`, async () => {
      const r = await pay(ROOM_TO_SEND + 1, dest);
      expect(r.payCalled).toBe(false);
      expect(r.err).toContain(ROOM_TO_SEND.toLocaleString());
    });
  }
});

describe("stats return both capacity figures with their components (§3.3)", () => {
  it("room to send and room to receive, from the stored reserves", async () => {
    const ch = await statsChannel();
    expect(ch.room_to_send_sats).toBe(ROOM_TO_SEND);
    expect(ch.room_to_receive_sats).toBe(ROOM_TO_RECEIVE);
  });

  it("D1.3: room to receive is below the raw remote balance by at least the channel reserve", async () => {
    const ch = await statsChannel();
    expect(ch.remote_sats - ch.room_to_receive_sats).toBeGreaterThanOrEqual(CH.remoteReserve);
  });

  it("R18(4): in-flight HTLCs are reported, not subtracted; the commit fee is reported", async () => {
    const ch = await statsChannel();
    expect(ch).toMatchObject({
      local_reserve_sats: CH.localReserve,
      remote_reserve_sats: CH.remoteReserve,
      pending_outgoing_sats: CH.pendingOut,
      pending_incoming_sats: CH.pendingIn,
      commit_fee_sats: CH.commitFee,
    });
    expect(ch.room_to_send_sats).toBe(CH.local - CH.localReserve); // not − pendingOut
    expect(ch.room_to_receive_sats).toBe(CH.remote - CH.remoteReserve); // not − pendingIn
  });
});

describe("R23(i) — a funder's room at every site: stats and both pay pre-check branches", () => {
  // The same channel, opened by this member. lnd v0.20.1-beta's maximum at
  // 2,500 sat/kw (commit fee 2,810 = FeeForWeight(2500, 1124)): local + 2,810
  // − reserve − FeeForWeight(5000, 1124 + 2·172) = 600,000 + 2,810 − 30,000
  // − 7,340 = 565,470 (derivation in capacity.funderHeadroom.test.ts).
  const LND_MAX = 565_470;
  beforeEach(() => {
    db.prepare("UPDATE lnd_channels SET is_initiator = 1").run();
  });

  it("stats: room to send is never above lnd's maximum, and within 1,000 of it", async () => {
    const room = (await statsChannel()).room_to_send_sats;
    expect(room).toBeLessThanOrEqual(LND_MAX);
    expect(LND_MAX - room).toBeLessThanOrEqual(1_000);
  });

  for (const [label, dest] of [["routed (treasury) branch", OTHER], ["direct-peer branch", HUB]] as const) {
    it(`${label}: refuses at the stats figure + 1, passes at it`, async () => {
      const room = (await statsChannel()).room_to_send_sats;
      const over = await pay(room + 1, dest);
      expect(over.payCalled).toBe(false);
      expect(over.err).toContain(room.toLocaleString());
      const at = await pay(room, dest);
      expect(at.err).toBeNull();
      expect(at.payCalled).toBe(true);
    });
  }
});
