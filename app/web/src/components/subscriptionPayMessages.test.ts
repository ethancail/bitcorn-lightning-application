import { describe, it, expect } from "vitest";
import { payErrorMessage, onrampErrorMessage } from "./subscriptionPayMessages";

describe("payErrorMessage", () => {
  it("maps every known pay-from-node error code to a clear sentence", () => {
    expect(payErrorMessage("insufficient_funds")).toMatch(/not enough/i);
    expect(payErrorMessage("fee_estimate_failed")).toMatch(/fee/i);
    expect(payErrorMessage("lnd_unavailable")).toMatch(/unavailable/i);
    expect(payErrorMessage("status_unavailable")).toMatch(/treasury/i);
    expect(payErrorMessage("payment_in_flight")).toMatch(/already being sent/i);
    expect(payErrorMessage("member_required")).toMatch(/member nodes/i);
  });

  it("includes the raw detail for send_failed", () => {
    expect(payErrorMessage("send_failed", "chain backend rejected tx")).toContain("chain backend rejected tx");
    expect(payErrorMessage("send_failed")).toMatch(/couldn't be sent/i);
  });

  it("surfaces the detail (not swallowed) for unknown codes", () => {
    expect(payErrorMessage("totally_unknown", "weird backend message")).toBe("weird backend message");
    expect(payErrorMessage(undefined, "no code but a detail")).toBe("no code but a detail");
  });

  it("falls back to a generic message when there is neither code nor detail", () => {
    expect(payErrorMessage()).toMatch(/something went wrong/i);
  });
});

describe("onrampErrorMessage", () => {
  it("maps the 503 coinbase_not_configured code", () => {
    expect(onrampErrorMessage("coinbase_not_configured")).toBe(
      "Coinbase Onramp is not configured on this node.",
    );
  });

  it("uses the fallback message for other errors", () => {
    expect(onrampErrorMessage("failed_to_generate_onramp_url", "boom")).toBe("boom");
    expect(onrampErrorMessage(undefined)).toMatch(/couldn't open coinbase onramp/i);
  });
});
