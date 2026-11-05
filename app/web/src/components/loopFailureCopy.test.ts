// drive-mode P2 item 7 (R18(12)): every value failure_reason can hold gives a
// member-facing sentence, distinct from every other, with no raw code in it.
// The money claims are checked against loopd's source in the module header.

import { describe, it, expect } from "vitest";
import { loopFailureSentence, type SwapDirection } from "./loopFailureCopy";

// The values each direction can produce (loopd's per loopout.go / loopin.go,
// mapped at loopd/swapclient_server.go:350-375), and Bitcorn's own.
const LOOPD: Record<SwapDirection, string[]> = {
  loop_out: [
    "FAILURE_REASON_OFFCHAIN",
    "FAILURE_REASON_TIMEOUT",
    "FAILURE_REASON_SWEEP_TIMEOUT",
    "FAILURE_REASON_INSUFFICIENT_VALUE",
    "FAILURE_REASON_TEMPORARY",
  ],
  loop_in: [
    "FAILURE_REASON_TIMEOUT",
    "FAILURE_REASON_TEMPORARY",
    "FAILURE_REASON_INCORRECT_AMOUNT",
    "FAILURE_REASON_ABANDONED",
    "FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE",
    "FAILURE_REASON_INCORRECT_HTLC_AMT_SWEPT",
  ],
};
const BITCORN = [
  "Quote expired",
  "interrupted",
  "requote_required",
  "fee_rate_over_quote",
  "miner_fee_unknown",
  "Loop state: FAILED",
];

/** Anything that reads as a raw code or an internal. */
const RAW = /FAILURE_REASON|_[a-z]+_|requote|miner_fee|fee_rate|Loop state:|interrupted\b|loopd|gRPC|HTLC|htlc|preimage/;

for (const direction of ["loop_out", "loop_in"] as const) {
  describe(`${direction}: every value has its own sentence`, () => {
    const values = [...LOOPD[direction], ...BITCORN];

    it("no sentence is the generic one (each value is recognised)", () => {
      const generic = loopFailureSentence("something nobody wrote", direction);
      for (const v of values) expect(loopFailureSentence(v, direction), v).not.toBe(generic);
    });

    it("every sentence differs from every other", () => {
      const sentences = values.map((v) => loopFailureSentence(v, direction));
      expect(new Set(sentences).size).toBe(values.length);
    });

    it("no sentence contains a raw code or an internal", () => {
      for (const v of values) {
        const s = loopFailureSentence(v, direction);
        expect(s.length, v).toBeGreaterThan(30);
        expect(s, v).not.toMatch(RAW);
      }
    });
  });
}

describe("the money claims, as loopd's source supports them", () => {
  it("Withdraw OFFCHAIN: the amount stayed, the prepay may not (loopout.go:1059-1060)", () => {
    const s = loopFailureSentence("FAILURE_REASON_OFFCHAIN", "loop_out");
    expect(s).toContain("The amount stayed in your connection, but the prepay may not come back.");
    expect(s).not.toMatch(/nothing left/i);
  });

  it("Withdraw SWEEP_TIMEOUT is the one that may have lost the amount (loopout.go:623-629)", () => {
    expect(loopFailureSentence("FAILURE_REASON_SWEEP_TIMEOUT", "loop_out")).toContain(
      "The amount may have left your connection without reaching your wallet",
    );
  });

  it("Top Up INSUFFICIENT_CONFIRMED_BALANCE sent nothing (loopin.go:801-815)", () => {
    expect(loopFailureSentence("FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE", "loop_in")).toContain("nothing was sent");
  });

  it("the pre-initiation refusals sent nothing (swapService.ts:200-252)", () => {
    for (const v of ["requote_required", "fee_rate_over_quote", "miner_fee_unknown", "Quote expired"]) {
      expect(loopFailureSentence(v, "loop_out"), v).toContain("nothing was sent");
    }
  });
});

describe("unknown or missing values", () => {
  it("get the generic sentence, which makes no claim about the money", () => {
    for (const v of [null, "", "lnd: unable to route", "FAILURE_REASON_OFFCHAIN" /* never a Top Up reason */]) {
      const s = loopFailureSentence(v, "loop_in");
      expect(s).toBe("The top-up didn't go through. Check your balances before trying again.");
    }
    expect(loopFailureSentence("connect ECONNREFUSED", "loop_out")).toBe(
      "The withdrawal didn't go through. Check your balances before trying again.",
    );
  });
});
