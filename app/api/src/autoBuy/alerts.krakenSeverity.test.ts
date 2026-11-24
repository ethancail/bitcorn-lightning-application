// kraken-autobuy P6, ruling S4 (capture review): a buy whose outcome is
// unknown raises AUTOBUY_ORDER_FAILED as a WARNING (amber), as the P4 plan
// said — Auto-Buy checks on its next run, nothing is lost yet. A plain
// rejection keeps its own severity, which is also a warning today. Severity is
// derived from the type alone (alerts.ts SEVERITY_BY_TYPE), so the context's
// error_code cannot change it; both cases are pinned so a per-code split
// cannot drift either one silently.
import { describe, it, expect } from "vitest";
import { decideAlertForFailure, type FailureSignal } from "./alerts";

const signal = (context: Record<string, unknown>): FailureSignal =>
  ({ type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context } as FailureSignal);

describe("AUTOBUY_ORDER_FAILED severity (S4)", () => {
  it("outcome_unknown is a warning", () => {
    const intent = decideAlertForFailure(signal({ error_code: "outcome_unknown", intended_buy_usd: 100, provider: "kraken" }), []);
    expect(intent).toMatchObject({ action: "create", type: "AUTOBUY_ORDER_FAILED", severity: "warning" });
  });
  it("a plain rejection keeps its severity (warning)", () => {
    const intent = decideAlertForFailure(signal({ error_code: "rejected", error_message: "EOrder:Insufficient funds", provider: "kraken" }), []);
    expect(intent).toMatchObject({ action: "create", type: "AUTOBUY_ORDER_FAILED", severity: "warning" });
  });
});
