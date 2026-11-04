// Ruling f: the API's new 'initiating' status (initiateSwap's claim; seconds
// long in a running process, or left by a crash until the startup sweep) gets
// a label on every page that maps swap statuses — never the raw status, and
// never the humanized fallback "Initiating".
//
// The seven mapping sites: the shared history badge (components/swapStatus.ts,
// used by Top Up and Cash Out), Cash Out's and Top Up's status text and
// technical rows, and the treasury Swap Operations page's own badge and text.
// The page functions are read through namespaces, so a mapping that is missing
// or not exported fails on its value rather than on an import error.

import { describe, expect, it } from "vitest";
import * as shared from "./swapStatus";
import * as withdraw from "../pages/WithdrawBitcoin";
import * as refill from "../pages/RefillChannel";
import * as swapOps from "../pages/SwapOperations";

const call = (mod: unknown, name: string, ...args: unknown[]) => {
  const fn = (mod as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
};

describe("'initiating' has a label at every swap-status mapping site", () => {
  it("shared history badge (Top Up and Cash Out)", () => {
    expect(call(shared, "statusBadge", "initiating")).toEqual({ label: "Starting…", cls: "badge-amber" });
  });

  it("Cash Out status text", () => {
    expect(call(withdraw, "statusText", "initiating", null)).toBe("Starting…");
  });

  it("Cash Out technical row", () => {
    expect(call(withdraw, "statusTechnical", "initiating")).toBe("initiating — Checking fees and route before the swap starts");
  });

  it("Top Up status text", () => {
    expect(call(refill, "statusText", "initiating", 250_000, null)).toBe("Starting…");
  });

  it("Top Up technical row", () => {
    expect(call(refill, "statusTechnical", "initiating")).toBe("initiating — Checking fees and route before the swap starts");
  });

  it("Swap Operations badge", () => {
    expect(call(swapOps, "statusBadge", "initiating")).toEqual({ label: "Starting…", cls: "badge-amber" });
  });

  it("Swap Operations status text", () => {
    expect(call(swapOps, "statusText", "initiating", null)).toBe("Starting…");
  });
});
