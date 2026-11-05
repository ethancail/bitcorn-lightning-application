// drive-mode P2, R33 finding 9: a temporary Loop failure is not final — loopd
// sets it so the swap is NOT abandoned, and a restart picks it up
// (loopout.go:398-405, loopin.go:566-571; looprpc/client.proto:690-693). The
// poller stores it as status "failed" (unchanged); the member's badge says
// "Not finished", matching its sentence. Display only.

import { describe, it, expect } from "vitest";
import { memberSwapBadge, statusBadge } from "./swapStatus";

describe("memberSwapBadge", () => {
  it("failed + FAILURE_REASON_TEMPORARY → \"Not finished\", not red", () => {
    const b = memberSwapBadge("failed", "FAILURE_REASON_TEMPORARY");
    expect(b.label).toBe("Not finished");
    expect(b.cls).toBe("badge-amber");
  });

  it("any other failure stays \"Failed\"", () => {
    for (const reason of ["FAILURE_REASON_OFFCHAIN", "interrupted", null]) {
      expect(memberSwapBadge("failed", reason)).toEqual(statusBadge("failed"));
    }
  });

  it("every other status is the shared map's", () => {
    for (const s of ["quote_created", "initiating", "executing", "confirming", "completed", "expired"]) {
      expect(memberSwapBadge(s, "FAILURE_REASON_TEMPORARY")).toEqual(statusBadge(s));
    }
  });
});
