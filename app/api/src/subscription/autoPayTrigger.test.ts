import { describe, it, expect } from "vitest";
import { shouldAutoPay, type ShouldAutoPayInput } from "./autoPayTrigger";
import type { AutoPayActiveAlertRow } from "./autoPayAlerts";

const NOW = 1_000_000;

function base(over: Partial<ShouldAutoPayInput> = {}): ShouldAutoPayInput {
  return {
    tier: "worker_lapsed",
    autoPayEnabled: true,
    sendInFlight: false,
    activeAlerts: [],
    nowSec: NOW,
    settlementCooldownSec: 7200, // 2h
    failureBackoffSec: 3600, // 1h
    failurePauseThreshold: 3,
    ...over,
  };
}

const succeeded = (updatedAt: number): AutoPayActiveAlertRow => ({
  id: 1,
  type: "AUTOPAY_SUCCEEDED",
  status: "active",
  consecutive_count: 1,
  updated_at: updatedAt,
});

const warning = (over: Partial<AutoPayActiveAlertRow>): AutoPayActiveAlertRow => ({
  id: 2,
  type: "AUTOPAY_INSUFFICIENT_FUNDS",
  status: "active",
  consecutive_count: 1,
  updated_at: NOW,
  ...over,
});

describe("shouldAutoPay — fire conditions", () => {
  it("fires when enabled and observed in worker_lapsed with no guards active", () => {
    expect(shouldAutoPay(base())).toBe("fire");
  });

  it("fires in routing_lapsed (recoverable-lapsed set)", () => {
    expect(shouldAutoPay(base({ tier: "routing_lapsed" }))).toBe("fire");
  });

  it("fires in close_due (still single-cycle recoverable)", () => {
    expect(shouldAutoPay(base({ tier: "close_due" }))).toBe("fire");
  });
});

describe("shouldAutoPay — skip conditions (not applicable / no action needed)", () => {
  it("skips when status is not applicable (tier null)", () => {
    expect(shouldAutoPay(base({ tier: null }))).toBe("skip");
  });

  it("skips when tier is current", () => {
    expect(shouldAutoPay(base({ tier: "current" }))).toBe("skip");
  });

  it("skips when tier is prepay (pre-activation, not renewal)", () => {
    expect(shouldAutoPay(base({ tier: "prepay" }))).toBe("skip");
  });

  it("skips when auto-pay is disabled", () => {
    expect(shouldAutoPay(base({ autoPayEnabled: false }))).toBe("skip");
  });
});

describe("shouldAutoPay — defer conditions (would fire, temporarily held)", () => {
  it("defers when a send is already in flight", () => {
    expect(shouldAutoPay(base({ sendInFlight: true }))).toBe("defer");
  });

  it("defers within the settlement cooldown after a recent success (the double-send guard)", () => {
    // success recorded 1h ago, cooldown is 2h → still cooling down
    expect(
      shouldAutoPay(base({ activeAlerts: [succeeded(NOW - 3600)] })),
    ).toBe("defer");
  });

  it("fires again once the settlement cooldown has elapsed (tx never confirmed)", () => {
    // success recorded 3h ago, cooldown is 2h → cooldown over, still lapsed → re-fire
    expect(
      shouldAutoPay(base({ activeAlerts: [succeeded(NOW - 10800)] })),
    ).toBe("fire");
  });

  it("ignores a dismissed SUCCEEDED row for cooldown purposes", () => {
    expect(
      shouldAutoPay(
        base({ activeAlerts: [{ ...succeeded(NOW - 60), status: "dismissed" }] }),
      ),
    ).toBe("fire");
  });

  it("defers while an active failure alert is within the backoff window", () => {
    expect(
      shouldAutoPay(base({ activeAlerts: [warning({ updated_at: NOW - 60 })] })),
    ).toBe("defer");
  });

  it("fires again once the failure backoff window has elapsed", () => {
    expect(
      shouldAutoPay(base({ activeAlerts: [warning({ updated_at: NOW - 7200 })] })),
    ).toBe("fire");
  });

  it("defers (auto-paused) when a failure alert has hit the pause threshold", () => {
    expect(
      shouldAutoPay(
        base({
          activeAlerts: [warning({ consecutive_count: 3, updated_at: NOW - 99999 })],
        }),
      ),
    ).toBe("defer");
  });

  it("skip takes precedence over defer (disabled + in-flight → skip)", () => {
    expect(
      shouldAutoPay(base({ autoPayEnabled: false, sendInFlight: true })),
    ).toBe("skip");
  });
});
