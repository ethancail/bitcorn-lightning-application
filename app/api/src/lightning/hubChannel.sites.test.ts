// Drive-mode P1 item 1 (spec P1 item 1; D1.1; R16(5), R17(5), R18(1)–(3)):
// every site that names "the hub channel" returns the same channel —
//   the largest ACTIVE channel to the treasury; between equal sizes the
//   lowest short channel ID in NUMERIC order (block, then tx, then output);
//   with none active, stats show the largest inactive one for display only
//   and payments carry no pin.
//
// Sites exercised, each through its own public entry point:
//   - GET /api/member/stats (index.ts)
//   - the payment pin (pay.ts, via payNetworkInvoice → payViaPaymentRequest)
//   - the pay pre-check's treasury branch and direct-peer branch
//     (network-payments.ts)
//   - the member Loop Out policy (swapPolicy.ts)
//   - the advisor's classifier (channelClassifier.ts getTreasuryChannel)
//
// Each channel's local_reserve_sat is set to exactly 1% of capacity so the
// spendable figures read the same under the 1% stand-in and under item 2's
// real reserve — this file pins WHICH channel, not how capacity is computed.
//
// Harness: real migrations on a temp-dir DB; only the LND boundary is stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-hub-channel-sites-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const OTHER = "03" + "cd".repeat(32);

const ln = vi.hoisted(() => ({
  decoded: { id: "aa".repeat(32), destination: "", tokens: 0, description: "t" } as any,
  payViaPaymentRequest: vi.fn(async (_args: any) => ({ id: "aa".repeat(32), tokens: 0, fee: 0, confirmed_at: "" })),
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

vi.mock("./loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loop")>();
  return {
    ...actual,
    getLoopOutTerms: async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 }),
  };
});

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "member", membership_status: "active" }) };
});

// No network: the rate fetch fails and is swallowed (fetchRateSafe).
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline in test"); }));

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { payNetworkInvoice } = await import("./network-payments");
const { checkMemberLoopOutPolicy } = await import("../swaps/swapPolicy");
const { getTreasuryChannel } = await import("../memberAdvisor/channelClassifier");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

type Ch = { id: string; peer?: string; cap: number; local: number; active: boolean };
function channels(...chs: Ch[]) {
  db.prepare("DELETE FROM lnd_channels").run();
  for (const c of chs) {
    db.prepare(`
      INSERT INTO lnd_channels
        (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
         active, private, updated_at, local_reserve_sat, remote_reserve_sat)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(c.id, c.peer ?? HUB, c.cap, c.local, c.cap - c.local - 10_000, c.active ? 1 : 0,
      Date.now(), Math.ceil(c.cap * 0.01), Math.ceil(c.cap * 0.01));
  }
}

async function statsChannel(): Promise<any> {
  let body = "";
  const res: any = { setHeader() {}, writeHead() { return res; }, end(c?: string) { if (c) body += c; return res; } };
  await handleRequest({ method: "GET", url: "/api/member/stats", headers: {} } as any, res);
  return JSON.parse(body).treasury_channel;
}

async function pinFor(tokens: number, destination = OTHER): Promise<string | undefined> {
  ln.decoded = { ...ln.decoded, destination, tokens };
  ln.payViaPaymentRequest.mockClear();
  await payNetworkInvoice("lnbcrt1test");
  expect(ln.payViaPaymentRequest).toHaveBeenCalledTimes(1);
  return ln.payViaPaymentRequest.mock.calls[0][0].outgoing_channel;
}

async function precheckError(tokens: number, destination: string): Promise<string> {
  ln.decoded = { ...ln.decoded, destination, tokens };
  ln.payViaPaymentRequest.mockClear();
  const err = await payNetworkInvoice("lnbcrt1test").then(() => null, (e: Error) => e.message);
  expect(err, "the pre-check should refuse").not.toBeNull();
  expect(ln.payViaPaymentRequest).not.toHaveBeenCalled();
  return err!;
}

beforeEach(() => {
  db.prepare("DELETE FROM network_payments").run();
});

// S is inserted FIRST, so a `LIMIT 1` with no ORDER BY returns it; and S has
// the higher local balance, so the old direct-peer rule (highest local) also
// picks it. L is the larger and must win everywhere.
const S = { id: "700000x5x0", cap: 1_000_000, local: 900_000, active: true };
const L = { id: "700001x1x0", cap: 2_000_000, local: 400_000, active: true };
// L spendable = 400,000 − 20,000 = 380,000; S spendable = 900,000 − 10,000 = 890,000.

describe("D1.1 — two active hub channels: every site returns the larger", () => {
  beforeEach(() => channels(S, L));

  it("stats", async () => {
    expect((await statsChannel()).channel_id).toBe(L.id);
  });

  it("the payment pin", async () => {
    expect(await pinFor(100_000)).toBe(L.id);
  });

  it("the pay pre-check, routed (treasury) branch", async () => {
    expect(await precheckError(2_000_000, OTHER)).toContain("380,000");
  });

  it("the pay pre-check, direct-peer branch when the destination is the treasury (R18(3))", async () => {
    expect(await precheckError(2_000_000, HUB)).toContain("380,000");
  });

  it("the member Loop Out policy", async () => {
    const r = await checkMemberLoopOutPolicy({ nodePubkey: "02" + "11".repeat(32), amountSat: 600_000, quotedFeeSat: 0 });
    expect(r).toMatchObject({ ok: false, code: "insufficient_treasury_channel" });
    expect((r as any).reason).toContain("400,000 local");
  });

  it("the classifier", () => {
    expect(getTreasuryChannel()?.channel_id).toBe(L.id);
  });
});

// R17(5) as the arc chat reads it: numeric order, never text. "100x1x0" sorts
// BEFORE "99x5x0" as text; numerically block 99 is lower. T100 is inserted
// first, so insertion order also points the wrong way.
const T100 = { id: "100x1x0", cap: 1_000_000, local: 300_000, active: true };
const T99 = { id: "99x5x0", cap: 1_000_000, local: 700_000, active: true };
// T99 spendable 690,000; T100 spendable 290,000.

describe("D1.1 — equal-size active hub channels: the numerically lowest short channel ID", () => {
  beforeEach(() => channels(T100, T99));

  it("stats", async () => {
    expect((await statsChannel()).channel_id).toBe(T99.id);
  });

  it("the payment pin", async () => {
    expect(await pinFor(100_000)).toBe(T99.id);
  });

  it("the pay pre-check, routed branch", async () => {
    expect(await precheckError(2_000_000, OTHER)).toContain("690,000");
  });

  it("the pay pre-check, direct-peer branch", async () => {
    expect(await precheckError(2_000_000, HUB)).toContain("690,000");
  });

  it("the member Loop Out policy", async () => {
    const r = await checkMemberLoopOutPolicy({ nodePubkey: "02" + "11".repeat(32), amountSat: 900_000, quotedFeeSat: 0 });
    expect((r as any).reason).toContain("700,000 local");
  });

  it("the classifier", () => {
    expect(getTreasuryChannel()?.channel_id).toBe(T99.id);
  });
});

describe("D1.1 — the larger hub channel inactive: every site returns the smaller active one", () => {
  // L inserted first this time, so a query that ignores `active` returns it.
  beforeEach(() => channels({ ...L, active: false }, S));

  it("stats", async () => {
    const ch = await statsChannel();
    expect(ch.channel_id).toBe(S.id);
    expect(ch.is_active).toBe(true);
  });

  it("the payment pin", async () => {
    expect(await pinFor(100_000)).toBe(S.id);
  });

  it("the pay pre-check, routed branch", async () => {
    expect(await precheckError(2_000_000, OTHER)).toContain("890,000");
  });

  it("the member Loop Out policy", async () => {
    const r = await checkMemberLoopOutPolicy({ nodePubkey: "02" + "11".repeat(32), amountSat: 2_500_000, quotedFeeSat: 0 });
    expect((r as any).reason).toContain("900,000 local");
  });

  it("the classifier", () => {
    expect(getTreasuryChannel()?.channel_id).toBe(S.id);
  });
});

describe("R18(2) — no active hub channel", () => {
  // S inserted first; L is the larger. A non-hub active channel carries the payment.
  beforeEach(() => channels(
    { ...S, active: false },
    { ...L, active: false },
    { id: "600000x1x0", peer: OTHER, cap: 1_000_000, local: 500_000, active: true },
  ));

  it("stats show the largest inactive hub channel, marked inactive (display only)", async () => {
    const ch = await statsChannel();
    expect(ch.channel_id).toBe(L.id);
    expect(ch.is_active).toBe(false);
  });

  it("a payment carries no pin", async () => {
    expect(await pinFor(100_000, "03" + "ef".repeat(32))).toBeUndefined();
  });

  it("the classifier and the Loop Out policy see no hub channel", async () => {
    expect(getTreasuryChannel()).toBeNull();
    const r = await checkMemberLoopOutPolicy({ nodePubkey: "02" + "11".repeat(32), amountSat: 300_000, quotedFeeSat: 0 });
    expect(r).toMatchObject({ ok: false, code: "no_treasury_channel" });
  });
});
