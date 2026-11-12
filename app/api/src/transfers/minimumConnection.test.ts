// Drive-mode P3 (R40(2)): the one minimum-connection formula,
//   min = ceil((F + S_min + K + Q + H + C) / (1 − 2r)).
// Golden figures are the P3 plan's table (item 3) at mockup r5's price,
// $76,848.88, on an anchor channel with commit fee A = 872 (so C = 1,532 and
// H = 1,409), default rails (Q = $3 = 3,904; under R40(2)'s old "lower of 2%
// or $3" it was the same, since 2% of 250,000 was about $3.84):
//   farmer  Save on fees 406,055   Keep room open 499,002
//   merchant Save on fees 370,605  Keep room open 636,167
// The plan's merchant figures with H = 0 reproduce the P1 recon exactly
// (369,167 and 634,729); that case is pinned too.

import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-minconn-"));
const { minimumConnection, minimumsForRole, usdCentsToSats } = await import("./minimumConnection");
const { funderHeadroomSats } = await import("../lightning/capacity");

const PRICE = 76_848.88;
const BASE = {
  usdPerBtc: PRICE,
  commitFeeSats: 872,
  commitmentType: "anchor",
  feeLimitUsdCents: 300,
};
const farmer = { ...BASE, role: "farmer" as const, loopMinSats: 250_000 };
const merchant = { ...BASE, role: "merchant" as const, loopMinSats: 100_000 };

describe("the terms at r5's price", () => {
  it("F: $70 → 91,088; $140 → 182,176; $200 → 260,251; $400 → 520,502", () => {
    expect(usdCentsToSats(7_000, PRICE)).toBe(91_088);
    expect(usdCentsToSats(14_000, PRICE)).toBe(182_176);
    expect(usdCentsToSats(20_000, PRICE)).toBe(260_251);
    expect(usdCentsToSats(40_000, PRICE)).toBe(520_502);
  });

  it("H = 1,409 and C = 1,532 for A = 872 on an anchor channel", () => {
    expect(funderHeadroomSats(872, "anchor")).toBe(1_409);
    const b = minimumConnection({ ...farmer, strategy: "save" })!;
    expect(b.H).toBe(1_409);
    expect(b.C).toBe(1_532);
  });

  it("farmer: K = 50,000 and Q = 3,904 (the $3 cap is lower than 2% of 250,000)", () => {
    const b = minimumConnection({ ...farmer, strategy: "save" })!;
    expect(b.K).toBe(50_000);
    expect(b.Q).toBe(3_904);
  });

  it("merchant: K = 0 and Q = 0", () => {
    const b = minimumConnection({ ...merchant, strategy: "save" })!;
    expect(b.K).toBe(0);
    expect(b.Q).toBe(0);
  });
});

describe("golden figures (the plan's table, + H + Q)", () => {
  it("farmer: Save on fees 406,055; Keep room open 499,002", () => {
    const m = minimumsForRole(farmer);
    expect(m.save!.sats).toBe(406_055);
    expect(m.open!.sats).toBe(499_002);
  });

  it("merchant: Save on fees 370,605; Keep room open 636,167", () => {
    const m = minimumsForRole(merchant);
    expect(m.save!.sats).toBe(370_605);
    expect(m.open!.sats).toBe(636_167);
  });

  it("the merchant method reproduces the P1 recon exactly with H = 0 (369,167 / 634,729)", () => {
    for (const [strategy, want] of [["save", 369_167], ["open", 634_729]] as const) {
      const b = minimumConnection({ ...merchant, strategy })!;
      expect(Math.ceil((b.F + b.S_min + b.K + b.Q + b.C) / (1 - 2 * b.r))).toBe(want);
    }
  });

  it("Manual only computes as Save on fees (R21(1))", () => {
    expect(minimumConnection({ ...farmer, strategy: "manual" })!.sats).toBe(406_055);
  });

  it("Keep room open is always the larger (R17(1))", () => {
    for (const role of [farmer, merchant]) {
      const m = minimumsForRole(role);
      expect(m.open!.sats).toBeGreaterThan(m.save!.sats);
    }
  });
});

describe("moves with its inputs", () => {
  it("a lower BTC price raises every size (the floors are dollars)", () => {
    expect(minimumConnection({ ...farmer, strategy: "save", usdPerBtc: 50_000 })!.sats).toBeGreaterThan(406_055);
  });

  it("a stricter Loop minimum raises it", () => {
    expect(minimumConnection({ ...merchant, strategy: "save", loopMinSats: 150_000 })!.sats).toBeGreaterThan(370_605);
  });

  it("a lower dollar figure lowers Q ($2 → 2,603)", () => {
    expect(minimumConnection({ ...farmer, strategy: "save", feeLimitUsdCents: 200 })!.Q).toBe(2_603);
  });
});

describe("no figure", () => {
  it("with no rate (state 'none')", () => {
    expect(minimumConnection({ ...farmer, strategy: "save", usdPerBtc: null })).toBeNull();
  });
  it("with no synced commitment fee", () => {
    expect(minimumConnection({ ...farmer, strategy: "save", commitFeeSats: null })).toBeNull();
  });
});
