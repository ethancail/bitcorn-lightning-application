// Drive-mode P1 item 9 (spec P1 item 9; D1.11; R18(11), R18(12)): listLoopSwaps
// carries loopd's failure_reason (client.proto SwapStatus field 14, enum
// FailureReason). The loader reads enums as strings, and with defaults on, a
// swap with no reason arrives as "FAILURE_REASON_NONE" — which means none.
//
// Harness: loop.routingCap.test.ts's fake gRPC client.

import { describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    ListSwaps(_req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      cb(null, {
        swaps: [
          { id_bytes: "aa", type: "LOOP_OUT", state: "FAILED", amt: "250000", failure_reason: "FAILURE_REASON_OFFCHAIN" },
          { id_bytes: "bb", type: "LOOP_IN", state: "FAILED", amt: "100000", failure_reason: "FAILURE_REASON_NONE" },
          { id_bytes: "cc", type: "LOOP_OUT", state: "SUCCESS", amt: "300000" },
        ],
      });
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

import { listLoopSwaps } from "./loop";

describe("D1.11 — listLoopSwaps carries loopd's failure reason", () => {
  it("a reason is carried as loopd's raw code; NONE or absent is null", async () => {
    const byId = Object.fromEntries((await listLoopSwaps()).map((s) => [s.id, s.failure_reason]));
    expect(byId).toEqual({ aa: "FAILURE_REASON_OFFCHAIN", bb: null, cc: null });
  });
});
