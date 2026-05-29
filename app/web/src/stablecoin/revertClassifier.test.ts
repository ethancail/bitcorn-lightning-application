// Unit tests for the pure-logic half of revertClassifier (Item 35). The
// I/O wrapper `classifyRevertOnChain` isn't tested directly — mocking
// viem's PublicClient adds boilerplate without catching any real
// regression that the rule-table tests don't already cover. If the
// wrapper's read calls ever change shape (e.g. multicall, batching), the
// integration with viem is what to verify, and that's a frontend-level
// concern caught by the receipt-poll live trial that produced Item 35
// in the first place.

import { describe, expect, it } from "vitest";
import { classifyRevertReason } from "./revertClassifier";

describe("classifyRevertReason", () => {
  it("returns the paused message when paused=true (highest priority)", () => {
    // Even with sufficient allowance, paused wins — settle() reverts on
    // the EnforcedPause guard before any token-transfer logic runs.
    expect(
      classifyRevertReason({ paused: true, allowance: 1_000_000n, amount: 500_000n }),
    ).toMatch(/paused/i);
  });

  it("paused takes precedence over insufficient allowance", () => {
    // If both fail-states are present, surface the paused cause; the
    // allowance shortfall is irrelevant while paused.
    const out = classifyRevertReason({
      paused: true,
      allowance: 0n,
      amount: 1_000_000n,
    });
    expect(out).toMatch(/paused/i);
    expect(out).not.toMatch(/allowance/i);
  });

  it("returns the allowance message when allowance < amount", () => {
    expect(
      classifyRevertReason({ paused: false, allowance: 100_000n, amount: 500_000n }),
    ).toMatch(/allowance/i);
  });

  it("treats allowance == amount as sufficient (boundary)", () => {
    // settle() consumes exactly `amount` via transferFrom — equal allowance
    // is enough. This boundary matters because allowance shortfall is the
    // most common non-paused revert, and getting the comparison wrong
    // would either over-attribute (showing allowance reason on unrelated
    // reverts) or under-attribute (missing the actual cause).
    expect(
      classifyRevertReason({ paused: false, allowance: 500_000n, amount: 500_000n }),
    ).toBe("Transaction reverted on-chain.");
  });

  it("returns the generic message when no state predicate matches", () => {
    expect(
      classifyRevertReason({ paused: false, allowance: 10_000_000n, amount: 500_000n }),
    ).toBe("Transaction reverted on-chain.");
  });

  it("handles zero amount (degenerate but safe)", () => {
    // settle() rejects zero amount before transferFrom, but the classifier
    // shouldn't crash. Both predicates evaluate as "no specific cause."
    expect(
      classifyRevertReason({ paused: false, allowance: 0n, amount: 0n }),
    ).toBe("Transaction reverted on-chain.");
  });
});
