// Ruling l (loop-fee-ceilings spec §1.5, §4 D; done-when D26): the Loop In
// quote asks exactly what execute will ask. F1 binds Loop In's max_swap_fee to
// the quoted swap fee alone (ruling 10), which only holds if the quote prices
// the same request execute makes — otherwise loopd's own re-quote at LoopIn
// can come back higher and fail with ErrSwapFeeTooHigh.
//
// The fields compared are the pricing-relevant ones loopd v0.33.0-beta reads
// on both messages (vendored proto, app/api/proto/looprpc/client.proto):
//   QuoteRequest  loop_in_last_hop = 5, loop_in_route_hints = 6, private = 7,
//                 conf_target = 2
//   LoopInRequest last_hop = 4,         route_hints = 9,         private = 10,
//                 htlc_conf_target = 6
//
// Drives the real swapService → loopProvider → loop.ts against a temp-dir
// database built by the real migration runner. Only the gRPC transport is a
// double, recording every request loop.ts builds; so what is asserted is
// what loopd would receive, from both quotes (the stored one and execute's
// fresh one) and from the LoopIn itself.
//
// ⚠ ORDERING: db/index.ts opens its file at module load from DB_DIR; the db
// and swapService are imported in beforeAll, after DB_DIR is set.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../config/env";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-loopin-parity-test-"));
process.env.DB_DIR = tmp;

const sent = vi.hoisted(() => ({ quotes: [] as any[], loopIns: [] as any[] }));

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    GetLoopInQuote(req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      sent.quotes.push(req);
      cb(null, { swap_fee_sat: "171", htlc_publish_fee_sat: "900", cltv_delta: "40", conf_target: 6 });
    }
    LoopIn(req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      sent.loopIns.push(req);
      cb(null, { id_bytes: "ab", server_message: "", htlc_address_p2tr: "bcrt1phtlc" });
    }
  }
  return {
    loadPackageDefinition: () => ({ looprpc: { SwapClient: FakeSwapClient } }),
    credentials: {
      createSsl: () => ({}),
      createFromMetadataGenerator: () => ({}),
      combineChannelCredentials: () => ({}),
    },
    Metadata: class { add() {} },
  };
});

// loopProvider imports lnd for Loop Out's address and probe; Loop In uses neither.
vi.mock("../lightning/lnd", () => ({
  probeLoopOutPaymentRoute: vi.fn(),
  createLndChainAddress: vi.fn(),
}));

const TREASURY = "02" + "b7".repeat(32);
const MEMBER = "02" + "11".repeat(32);

type Svc = typeof import("./swapService");
let svc: Svc;

beforeAll(async () => {
  // loop.ts reads the cert and macaroon when it first builds its client.
  const cert = path.join(tmp, "tls.cert");
  const mac = path.join(tmp, "loop.macaroon");
  fs.writeFileSync(cert, "stub");
  fs.writeFileSync(mac, "stub");
  ENV.loopTlsCertPath = cert;
  ENV.loopMacaroonPath = mac;
  ENV.treasuryPubkey = TREASURY;

  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  svc = await import("./swapService");
});

beforeEach(() => {
  sent.quotes.length = 0;
  sent.loopIns.length = 0;
});

/** Quote, then execute, a member Loop In; return what loopd received. */
async function quoteAndExecute() {
  const { swapRequest } = await svc.createLoopInQuote({ nodePubkey: MEMBER, role: "member", amountSat: 250_000 });
  await svc.initiateSwap(swapRequest.id, undefined, { max_swap_fee_sat: 171, max_miner_fee_sat: 900 });
  // The stored quote, and execute's fresh quote (the fee-rate precheck).
  expect(sent.quotes).toHaveLength(2);
  expect(sent.loopIns).toHaveLength(1);
  return { quotes: sent.quotes, loopIn: sent.loopIns[0] };
}

const hex = (b: unknown) => (b == null ? b : Buffer.from(b as Buffer).toString("hex"));

describe("D26: the Loop In quote carries execute's pricing-relevant fields", () => {
  it("execute sends the treasury as last hop and private: true (the reference)", async () => {
    const { loopIn } = await quoteAndExecute();
    expect(hex(loopIn.last_hop)).toBe(TREASURY);
    expect(loopIn.private).toBe(true);
    expect(loopIn.route_hints).toBeUndefined();
  });

  it.each([
    { which: "the stored quote", i: 0 },
    { which: "execute's fresh quote", i: 1 },
  ])("$which: loop_in_last_hop equals execute's last_hop", async ({ i }) => {
    const { quotes, loopIn } = await quoteAndExecute();
    expect(hex(quotes[i].loop_in_last_hop)).toBe(TREASURY);
    expect(hex(quotes[i].loop_in_last_hop)).toBe(hex(loopIn.last_hop));
  });

  it.each([
    { which: "the stored quote", i: 0 },
    { which: "execute's fresh quote", i: 1 },
  ])("$which: private and route hints equal execute's", async ({ i }) => {
    const { quotes, loopIn } = await quoteAndExecute();
    expect(quotes[i].private).toBe(loopIn.private);
    expect(quotes[i].loop_in_route_hints).toEqual(loopIn.route_hints);
  });

  it.each([
    { which: "the stored quote", i: 0 },
    { which: "execute's fresh quote", i: 1 },
  ])("$which: conf_target equals execute's htlc_conf_target", async ({ i }) => {
    const { quotes, loopIn } = await quoteAndExecute();
    expect(quotes[i].conf_target).toBe(loopIn.htlc_conf_target);
  });
});
