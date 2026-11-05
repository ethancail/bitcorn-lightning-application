// Drive-mode P1 item 4 (spec P1 item 4, §3.3; D1.5, D1.6; R15(7), R18(7),
// R18(8); confirmed by R20): every MEMBER Lightning payment carries a fee
// limit of 10 sats + 1% of the amount —
//   max_fee_mtokens = 10,000 + amount_msat / 100   (base 10 sat, 10,000 ppm)
// set on the server, with or without a hub-channel pin; the treasury's own
// payments carry none. The limit is stored per payment (migration 063) and
// shown before sending through /api/network/decode, rounded UP to whole sats.
// lnd applies the limit at pathfinding and fails an over-limit payment as
// NO_ROUTE, which used to read "No route found… check capacity"; after such a
// failure a read-only route query WITHOUT the limit tells a fee refusal from
// a real no-route (R18(8)).
//
// Harness: hubChannel.sites.test.ts's — real migrations on a temp-dir DB; only
// the LND boundary is stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pay-maxfee-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const DEST = "03" + "cd".repeat(32);

const ln = vi.hoisted(() => ({
  n: 0,
  tokens: 1_000,
  payError: null as unknown,
  route: null as null | { fee: number; fee_mtokens: string },
  payViaPaymentRequest: vi.fn(),
  getRouteToDestination: vi.fn(),
}));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    decodePaymentRequest: vi.fn(async () => ({
      id: (++ln.n).toString(16).padStart(64, "0"),
      destination: DEST,
      tokens: ln.tokens,
      mtokens: String(ln.tokens * 1000),
      description: "t",
      cltv_delta: 40,
      routes: [],
      features: [],
      payment: "ab".repeat(32),
    })),
    payViaPaymentRequest: ln.payViaPaymentRequest,
    getRouteToDestination: ln.getRouteToDestination,
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
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline in test"); }));

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { payNetworkInvoice } = await import("./network-payments");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

function setRole(role: "member" | "treasury") {
  db.prepare("DELETE FROM lnd_node_info").run();
  db.prepare(`
    INSERT INTO lnd_node_info (id, pubkey, alias, network, node_role, membership_status, updated_at)
    VALUES (1, ?, 'n', 'regtest', ?, 'active', ?)
  `).run(role === "treasury" ? HUB : "02" + "11".repeat(32), role, Date.now());
}

function channels(withHub: boolean) {
  db.prepare("DELETE FROM lnd_channels").run();
  const add = (id: string, peer: string) => db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, is_initiator)
    VALUES (?, ?, 5000000, 4000000, 900000, 1, 0, ?, 50000, 50000, 0)
  `).run(id, peer, Date.now());
  if (withHub) add("800000x1x0", HUB);
  else add("700000x1x0", "03" + "ee".repeat(32));
}

beforeEach(() => {
  setRole("member");
  channels(true);
  ln.tokens = 1_000;
  ln.payViaPaymentRequest.mockReset();
  ln.payViaPaymentRequest.mockImplementation(async () => {
    if (ln.payError) throw ln.payError;
    return { id: "x", tokens: ln.tokens, fee: 0, confirmed_at: "" };
  });
  ln.payError = null;
  ln.route = null;
  ln.getRouteToDestination.mockReset();
  ln.getRouteToDestination.mockImplementation(async () => {
    if (!ln.route) throw [503, "PaymentPathfindingFailedToFindPossibleRoute"];
    return { route: { ...ln.route, hops: [], tokens: ln.tokens, timeout: 1 } };
  });
});

const sentMaxFee = () => ln.payViaPaymentRequest.mock.calls[0]?.[0]?.max_fee_mtokens;

describe("D1.5 — the member fee limit: 10 sats + 1%, exact, in millisats", () => {
  for (const [tokens, expected] of [[1, "10010"], [1_000, "20000"], [1_234_567, "12355670"]] as const) {
    for (const withHub of [true, false]) {
      it(`${tokens.toLocaleString()} sats ${withHub ? "pinned to the hub" : "with no hub channel"} → max_fee_mtokens ${expected}`, async () => {
        channels(withHub);
        ln.tokens = tokens;
        await payNetworkInvoice("lnbcrt1test");
        expect(ln.payViaPaymentRequest).toHaveBeenCalledTimes(1);
        expect(sentMaxFee()).toBe(expected);
      });
    }
  }

  it("R18(7): the treasury's own payments carry no limit", async () => {
    setRole("treasury");
    channels(false);
    await payNetworkInvoice("lnbcrt1test");
    expect(ln.payViaPaymentRequest).toHaveBeenCalledTimes(1);
    expect(sentMaxFee()).toBeUndefined();
  });

  it("the limit is stored with the payment, in sats rounded up (migration 063)", async () => {
    ln.tokens = 1_234_567; // 12,355,670 msat → 12,356 sats
    await payNetworkInvoice("lnbcrt1test");
    const row = db.prepare("SELECT max_fee_sats FROM network_payments ORDER BY id DESC LIMIT 1").get() as any;
    expect(row.max_fee_sats).toBe(12_356);
  });
});

describe("D1.6 — the most a payment can cost, before sending", () => {
  async function decode(): Promise<any> {
    let body = "";
    const listeners: Record<string, (c?: any) => void> = {};
    const req: any = {
      method: "POST", url: "/api/network/decode", headers: { "content-type": "application/json" },
      on(ev: string, cb: (c?: any) => void) { listeners[ev] = cb; return req; },
    };
    const res: any = { setHeader() {}, writeHead() { return res; }, end(c?: string) { if (c) body += c; return res; } };
    await handleRequest(req, res);
    listeners.data?.(JSON.stringify({ payment_request: "lnbcrt1test" }));
    await listeners.end?.();
    for (let i = 0; i < 10 && !body; i++) await new Promise((r) => setTimeout(r, 0));
    return JSON.parse(body);
  }

  it("/api/network/decode returns max_fee_sats, rounded up", async () => {
    ln.tokens = 1_234_567;
    const d = await decode();
    expect(d.tokens, "the route decoded the invoice").toBe(1_234_567);
    expect(d.max_fee_sats).toBe(12_356);
  });
});

describe("R18(8) — a fee refusal is told apart from a real no-route", () => {
  const NO_ROUTE = [503, "PaymentPathfindingFailedToFindPossibleRoute", {}];

  it("a route exists but costs more than the limit → the fee sentence, not the capacity one", async () => {
    ln.payError = NO_ROUTE;
    ln.route = { fee: 31, fee_mtokens: "31000" }; // limit for 1,000 sats is 20 sats
    const r = await payNetworkInvoice("lnbcrt1test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("costs 31 sats in fees");
    expect(r.error).toContain("20-sat limit");
    expect(r.error).not.toContain("outbound capacity");
    // The query is read-only and asks WITHOUT the limit.
    expect(ln.getRouteToDestination).toHaveBeenCalledTimes(1);
    expect(ln.getRouteToDestination.mock.calls[0][0].max_fee).toBeUndefined();
    expect(ln.getRouteToDestination.mock.calls[0][0].max_fee_mtokens).toBeUndefined();
  });

  it("no route at any fee → the capacity sentence stays", async () => {
    ln.payError = NO_ROUTE;
    ln.route = null;
    const r = await payNetworkInvoice("lnbcrt1test");
    expect(r.error).toContain("No route found");
  });
});
