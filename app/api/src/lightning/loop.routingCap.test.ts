// D13: the two routing ceilings sent to loopd on LoopOut are the routing cap
// (its own setting, default 1% = 10,000 ppm) applied separately to the swap
// amount and to the prepay — not a reuse of max_swap_fee
// (loop-fee-ceilings spec §4 A and B; §13 item 3).
//
// executeLoopOutSwap is shared by A, B and C1–C3, so this pins the cap on
// every Loop Out site at once. The gRPC transport is a double that records
// the LoopOut request; the real loop.ts builds it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Record<string, any> = {};

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    LoopOut(req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      sent.LoopOut = req;
      cb(null, { id_bytes: "ab", server_message: "" });
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
vi.mock("fs", () => {
  const existsSync = () => true;
  const readFileSync = () => Buffer.from("stub");
  return { default: { existsSync, readFileSync }, existsSync, readFileSync };
});

import { executeLoopOutSwap } from "./loop";
import { ENV } from "../config/env";

beforeEach(() => {
  delete sent.LoopOut;
});

describe("D13: routing ceilings are the cap times each payment", () => {
  it("the cap's default is 1% (10,000 ppm)", () => {
    expect(ENV.loopRoutingFeeCapPpm).toBe(10_000);
  });

  it("max_swap_routing_fee = cap × swap amount; max_prepay_routing_fee = cap × prepay", async () => {
    await executeLoopOutSwap({
      amt: 250_000,
      dest: "bcrt1qdest",
      outgoing_chan_set: [],
      max_swap_fee: 835,
      max_miner_fee: 1_200,
      max_prepay_amt: 30_123,
      sweep_conf_target: 6,
    });
    expect(sent.LoopOut.max_swap_routing_fee).toBe(2_500);
    // 1% of 30,123 is 301.23: rounded DOWN, so the ceiling never exceeds 1%.
    expect(sent.LoopOut.max_prepay_routing_fee).toBe(301);
  });
});
