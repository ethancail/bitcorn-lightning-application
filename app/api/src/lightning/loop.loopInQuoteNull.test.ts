// Drive-mode P1 item 10 (spec P1 item 10; D1.12; R18(13), R8(b)): a failed
// HTLC-fee estimate is never a 0. loopd answers GetLoopInQuote with
// htlc_publish_fee_sat = −1 when MinerFeeEstimationFailed; getLoopInQuote
// used to clamp that to 0 (`Math.max(0, htlcFee)`), so "failed" read as
// "free". It is now null, and so is the total it would have fed.
// (loop-fee-ceilings' ruling Z already refuses the quote with
// miner_fee_unknown before anything is stored; this removes the 0 at its
// source, as drive-mode's share of the clamp entry.)
//
// Harness: loop.routingCap.test.ts's fake gRPC client.

import { describe, expect, it, vi } from "vitest";

const loopd = vi.hoisted(() => ({ htlcFee: "-1" }));

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    GetLoopInQuote(_req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      cb(null, { swap_fee_sat: "250", htlc_publish_fee_sat: loopd.htlcFee, cltv_delta: 1000, conf_target: 6 });
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

import { getLoopInQuote } from "./loop";

describe("D1.12 — a failed HTLC-fee estimate is null, never 0", () => {
  it("loopd's −1 → htlc_publish_fee_sat null and total_cost_sats null", async () => {
    loopd.htlcFee = "-1";
    const q = await getLoopInQuote(250_000);
    expect(q.htlc_publish_fee_sat).toBeNull();
    expect(q.total_cost_sats).toBeNull();
  });

  it("a real estimate is passed through, and the total adds it", async () => {
    loopd.htlcFee = "1500";
    const q = await getLoopInQuote(250_000);
    expect(q.htlc_publish_fee_sat).toBe(1500);
    expect(q.total_cost_sats).toBe(1750);
  });
});
