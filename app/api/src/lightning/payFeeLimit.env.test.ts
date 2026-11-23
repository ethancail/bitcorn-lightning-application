// code-audit-2, Loop and money-path env parses (the F02 follow-up): the member
// Lightning payment fee limit's two env values. Before the fix, "abc" gave
// NaN and BigInt(Math.round(NaN)) threw a RangeError, which stopped every
// member payment (fail closed); "" gave 0, which silently shrank the limit.
// Both ⚠ directions were red on that code. Only the env parse changed:
// maxFeeMtokensFor's formula is payFeeLimit.test.ts's, unchanged.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pay-fee-limit-env-"));

const VARS = ["MEMBER_PAY_MAX_FEE_BASE_SAT", "MEMBER_PAY_MAX_FEE_PPM"] as const;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  vi.restoreAllMocks();
});

async function load(env: Partial<Record<(typeof VARS)[number], string>>) {
  vi.resetModules();
  for (const v of VARS) {
    if (env[v] === undefined) delete process.env[v];
    else process.env[v] = env[v];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return import("./payFeeLimit");
}

// 1,000 sats at the defaults: 10,000 msat + 1,000,000 / 100 = 20,000 msat.
const AMOUNT = "1000000";
const AT_DEFAULTS = "20000";

describe("MEMBER_PAY_MAX_FEE_BASE_SAT (default 10 sats)", () => {
  it("⚠ \"abc\": the limit is the default formula, not a RangeError", async () => {
    const { maxFeeMtokensFor } = await load({ MEMBER_PAY_MAX_FEE_BASE_SAT: "abc" });
    expect(maxFeeMtokensFor(AMOUNT)).toBe(AT_DEFAULTS);
  });

  it("⚠ empty: the base is the default 10 sats, not 0", async () => {
    const { maxFeeMtokensFor } = await load({ MEMBER_PAY_MAX_FEE_BASE_SAT: "" });
    expect(maxFeeMtokensFor(AMOUNT)).toBe(AT_DEFAULTS);
  });

  it("control: a configured 0.5 is 500 msat; a configured 0 is kept", async () => {
    expect((await load({ MEMBER_PAY_MAX_FEE_BASE_SAT: "0.5" })).maxFeeMtokensFor(AMOUNT)).toBe("10500");
    expect((await load({ MEMBER_PAY_MAX_FEE_BASE_SAT: "0" })).maxFeeMtokensFor(AMOUNT)).toBe("10000");
  });
});

describe("MEMBER_PAY_MAX_FEE_PPM (default 10,000 ppm)", () => {
  it("⚠ \"abc\": the limit is the default formula, not a RangeError", async () => {
    const { maxFeeMtokensFor } = await load({ MEMBER_PAY_MAX_FEE_PPM: "abc" });
    expect(maxFeeMtokensFor(AMOUNT)).toBe(AT_DEFAULTS);
  });

  it("⚠ empty: the ppm is the default 10,000, not 0", async () => {
    const { maxFeeMtokensFor } = await load({ MEMBER_PAY_MAX_FEE_PPM: "" });
    expect(maxFeeMtokensFor(AMOUNT)).toBe(AT_DEFAULTS);
  });

  it("control: a configured 0 is kept — the base alone", async () => {
    expect((await load({ MEMBER_PAY_MAX_FEE_PPM: "0" })).maxFeeMtokensFor(AMOUNT)).toBe("10000");
  });
});
