// fee-estimates step 4 — what closeTreasuryChannel hands ln-service (spec §9,
// P17 (a), F1, F2). ln-service is the mock; lnd.ts is the real code under test.
//
// The second describe drives the REAL ln-service closeChannel validation with
// a stub LND, to pin the reason force closes carry no fee setting: ln-service
// refuses one before any RPC (lightning close_channel.js:80-81).

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ closeArgs: [] as any[] }));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    authenticatedLndGrpc: () => ({ lnd: { mocked: true } }),
    closeChannel: async (args: any) => {
      rpc.closeArgs.push(args);
      return { transaction_id: "tx" };
    },
  };
});

// The client's credential preconditions are filesystem checks.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: { ...actual, existsSync: () => true, readFileSync: () => Buffer.from("x") },
    existsSync: () => true,
    readFileSync: () => Buffer.from("x"),
  };
});

import { closeTreasuryChannel } from "./lnd";
import { FEE_RATE_CEILING_SAT_PER_VBYTE } from "../fees/feeEstimates";

beforeEach(() => {
  rpc.closeArgs = [];
});

describe("closeTreasuryChannel — the fee settings sent to ln-service", () => {
  it("cooperative close: the proposed rate as tokens_per_vbyte, and the 200 ceiling as max_tokens_per_vbyte", async () => {
    await closeTreasuryChannel("ab".repeat(32), 1, { isForce: false, chainFeeTokensPerVbyte: 7 });
    expect(rpc.closeArgs).toHaveLength(1);
    expect(rpc.closeArgs[0]).toMatchObject({
      transaction_id: "ab".repeat(32),
      transaction_vout: 1,
      is_force_close: false,
      tokens_per_vbyte: 7,
      max_tokens_per_vbyte: FEE_RATE_CEILING_SAT_PER_VBYTE,
    });
    expect(FEE_RATE_CEILING_SAT_PER_VBYTE).toBe(200);
  });

  it("force close: no rate and no maximum go out, even if a rate is passed", async () => {
    await closeTreasuryChannel("ab".repeat(32), 1, { isForce: true, chainFeeTokensPerVbyte: 7 });
    const args = rpc.closeArgs[0];
    expect(args.is_force_close).toBe(true);
    expect(args.tokens_per_vbyte).toBeUndefined();
    expect(args.max_tokens_per_vbyte).toBeUndefined();
  });
});

describe("why: the real ln-service refuses any fee setting on a force close", () => {
  it("closeChannel({ is_force_close, tokens_per_vbyte }) → [400, 'UnexpectedFeeSettingForForceCloseChannel']", async () => {
    const real = await vi.importActual<any>("ln-service");
    const err = await real
      .closeChannel({
        lnd: { default: { closeChannel: () => { throw new Error("must not reach LND"); } } },
        transaction_id: "ab".repeat(32),
        transaction_vout: 1,
        is_force_close: true,
        tokens_per_vbyte: 7,
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toEqual([400, "UnexpectedFeeSettingForForceCloseChannel"]);
  });
});
