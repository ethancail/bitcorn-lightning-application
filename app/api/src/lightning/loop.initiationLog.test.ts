// Ruling r (loop-fee-ceilings spec §1.6; done-when D25): at swap initiation
// Bitcorn logs ONE line carrying the ceilings it sends loopd, amounts only, so
// the post-deploy check has a Bitcorn-side record alongside loopd's own.
//
// executeLoopOutSwap is shared by A, B and C1–C3, and executeLoopInSwap is D's,
// so these two builders are every site that starts a swap. The gRPC transport
// is a double that records each request; the real loop.ts builds it, and the
// test compares the logged amounts against what loopd received.
//
// "Amounts only" (D25): no address, invoice, payment hash, preimage, pubkey,
// channel id or macaroon — every logged value is a number.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Record<string, any> = {};

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    LoopOut(req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      sent.LoopOut = req;
      cb(null, { id_bytes: "ab", server_message: "" });
    }
    LoopIn(req: unknown, _opts: unknown, cb: (e: unknown, r?: unknown) => void) {
      sent.LoopIn = req;
      cb(null, { id_bytes: "cd", server_message: "", htlc_address_p2tr: "bcrt1phtlc" });
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

import { executeLoopInSwap, executeLoopOutSwap } from "./loop";

const DEST = "bcrt1qdestdestdestdestdestdestdestdestdest0";
const LAST_HOP = "02" + "b7".repeat(32);

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete sent.LoopOut;
  delete sent.LoopIn;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

/** The initiation lines for one swap type, as [message, payload] pairs. */
function initiationLines(kind: "LoopOut" | "LoopIn") {
  return log.mock.calls.filter(
    (c) => typeof c[0] === "string" && c[0].startsWith(`[loop] ${kind} initiation`),
  );
}

async function loopOut() {
  await executeLoopOutSwap({
    amt: 250_000,
    dest: DEST,
    outgoing_chan_set: ["939318x1492x1"],
    max_swap_fee: 25,
    max_miner_fee: 3_793,
    max_prepay_amt: 1_337,
    sweep_conf_target: 6,
  });
}

async function loopIn() {
  await executeLoopInSwap({
    amt: 250_000,
    max_swap_fee: 171,
    max_miner_fee: 900,
    htlc_conf_target: 6,
    last_hop: LAST_HOP,
  });
}

describe("D25: one initiation log line with the ceilings sent, amounts only", () => {
  it("Loop Out (A, B, C1–C3): exactly one line, each ceiling equal to the LoopOut request's", async () => {
    await loopOut();
    const lines = initiationLines("LoopOut");
    expect(lines).toHaveLength(1);
    const payload = lines[0][1];
    for (const k of [
      "amt",
      "max_swap_fee",
      "max_miner_fee",
      "max_prepay_amt",
      "max_swap_routing_fee",
      "max_prepay_routing_fee",
    ]) {
      expect(payload?.[k], k).toBe(Number(sent.LoopOut[k]));
    }
    // The routing ceilings are derived inside loop.ts; pin them too.
    expect(payload.max_swap_routing_fee).toBe(2_500);
    expect(payload.max_prepay_routing_fee).toBe(13);
  });

  it("Loop In (D): exactly one line, each ceiling equal to the LoopIn request's", async () => {
    await loopIn();
    const lines = initiationLines("LoopIn");
    expect(lines).toHaveLength(1);
    const payload = lines[0][1];
    for (const k of ["amt", "max_swap_fee", "max_miner_fee"]) {
      expect(payload?.[k], k).toBe(Number(sent.LoopIn[k]));
    }
  });

  it.each([
    { kind: "LoopOut" as const, run: loopOut },
    { kind: "LoopIn" as const, run: loopIn },
  ])("$kind: amounts only — every value a number, no address, channel or pubkey", async ({ kind, run }) => {
    await run();
    const [msg, payload] = initiationLines(kind)[0] ?? [];
    expect(payload).toBeDefined();
    for (const [k, v] of Object.entries(payload as object)) {
      expect(typeof v, k).toBe("number");
    }
    const whole = String(msg) + JSON.stringify(payload);
    expect(whole).not.toContain(DEST);
    expect(whole).not.toContain(LAST_HOP);
    expect(whole).not.toContain("939318");
  });
});
