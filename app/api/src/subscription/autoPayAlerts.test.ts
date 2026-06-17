import { describe, it, expect } from "vitest";
import {
  SEVERITY_BY_TYPE,
  classifyAutoPayError,
  severityForAlertType,
  shouldAutoClear,
  decideAutoPayAlert,
  resolveOnSuccess,
  type AutoPayAlertType,
  type AutoPayActiveAlertRow,
} from "./autoPayAlerts";

describe("classifyAutoPayError", () => {
  it("maps the four send-phase errors to their alert types", () => {
    expect(classifyAutoPayError("insufficient_funds")).toBe("AUTOPAY_INSUFFICIENT_FUNDS");
    expect(classifyAutoPayError("lnd_unavailable")).toBe("AUTOPAY_LND_UNAVAILABLE");
    expect(classifyAutoPayError("send_failed")).toBe("AUTOPAY_PAYMENT_FAILED");
    expect(classifyAutoPayError("fee_estimate_failed")).toBe("AUTOPAY_FEE_ESTIMATE_FAILED");
  });

  it("returns null (silent defer) for status_unavailable and payment_in_flight", () => {
    expect(classifyAutoPayError("status_unavailable")).toBeNull();
    expect(classifyAutoPayError("payment_in_flight")).toBeNull();
  });
});

describe("SEVERITY_BY_TYPE / severityForAlertType", () => {
  it("uses the ('info','warning') domain — SUCCEEDED is info, failures are warning", () => {
    expect(SEVERITY_BY_TYPE.AUTOPAY_SUCCEEDED).toBe("info");
    expect(SEVERITY_BY_TYPE.AUTOPAY_INSUFFICIENT_FUNDS).toBe("warning");
    expect(SEVERITY_BY_TYPE.AUTOPAY_LND_UNAVAILABLE).toBe("warning");
    expect(SEVERITY_BY_TYPE.AUTOPAY_PAYMENT_FAILED).toBe("warning");
    expect(SEVERITY_BY_TYPE.AUTOPAY_FEE_ESTIMATE_FAILED).toBe("warning");
  });

  it("severityForAlertType reads from the single source of truth", () => {
    expect(severityForAlertType("AUTOPAY_SUCCEEDED")).toBe("info");
    expect(severityForAlertType("AUTOPAY_PAYMENT_FAILED")).toBe("warning");
  });

  it("never emits 'critical' (auto-pay has a long grace runway)", () => {
    for (const sev of Object.values(SEVERITY_BY_TYPE)) {
      expect(sev === "info" || sev === "warning").toBe(true);
    }
  });
});

describe("shouldAutoClear", () => {
  it("is true for the four warning types (clear on next successful pay)", () => {
    expect(shouldAutoClear("AUTOPAY_INSUFFICIENT_FUNDS")).toBe(true);
    expect(shouldAutoClear("AUTOPAY_LND_UNAVAILABLE")).toBe(true);
    expect(shouldAutoClear("AUTOPAY_PAYMENT_FAILED")).toBe(true);
    expect(shouldAutoClear("AUTOPAY_FEE_ESTIMATE_FAILED")).toBe(true);
  });

  it("is false for AUTOPAY_SUCCEEDED (its lifecycle is time/episode-based, not failure-resolution)", () => {
    expect(shouldAutoClear("AUTOPAY_SUCCEEDED")).toBe(false);
  });
});

describe("decideAutoPayAlert", () => {
  const active = (over: Partial<AutoPayActiveAlertRow>): AutoPayActiveAlertRow => ({
    id: 1,
    type: "AUTOPAY_INSUFFICIENT_FUNDS",
    status: "active",
    consecutive_count: 1,
    updated_at: 100,
    ...over,
  });

  it("creates a new alert when none of that type is active", () => {
    const intent = decideAutoPayAlert(
      { type: "AUTOPAY_PAYMENT_FAILED", context: { detail: "boom" } },
      [],
    );
    expect(intent).toEqual({
      action: "create",
      type: "AUTOPAY_PAYMENT_FAILED",
      severity: "warning",
      context: { detail: "boom" },
    });
  });

  it("derives info severity when creating an AUTOPAY_SUCCEEDED row", () => {
    const intent = decideAutoPayAlert(
      { type: "AUTOPAY_SUCCEEDED", context: { txid: "abc", price_sats: 50000 } },
      [],
    );
    expect(intent).toMatchObject({ action: "create", severity: "info" });
  });

  it("increments an existing active alert of the same type", () => {
    const intent = decideAutoPayAlert(
      { type: "AUTOPAY_INSUFFICIENT_FUNDS", context: { balance_sats: 10 } },
      [active({ id: 7, type: "AUTOPAY_INSUFFICIENT_FUNDS" })],
    );
    expect(intent).toEqual({
      action: "increment",
      alertId: 7,
      context: { balance_sats: 10 },
    });
  });

  it("does not dedup against a dismissed alert — a recurrence opens a fresh row", () => {
    const intent = decideAutoPayAlert(
      { type: "AUTOPAY_INSUFFICIENT_FUNDS", context: {} },
      [active({ id: 7, status: "dismissed" })],
    );
    expect(intent.action).toBe("create");
  });

  it("returns noop for a null signal", () => {
    expect(decideAutoPayAlert(null, [])).toEqual({ action: "noop" });
  });
});

describe("resolveOnSuccess", () => {
  const rows: AutoPayActiveAlertRow[] = [
    { id: 1, type: "AUTOPAY_INSUFFICIENT_FUNDS", status: "active", consecutive_count: 2, updated_at: 100 },
    { id: 2, type: "AUTOPAY_LND_UNAVAILABLE", status: "active", consecutive_count: 1, updated_at: 100 },
    { id: 3, type: "AUTOPAY_SUCCEEDED", status: "active", consecutive_count: 1, updated_at: 100 },
    { id: 4, type: "AUTOPAY_PAYMENT_FAILED", status: "dismissed", consecutive_count: 1, updated_at: 100 },
  ];

  it("resolves all active warning alerts", () => {
    const resolutions = resolveOnSuccess(rows);
    expect(resolutions.map((r) => r.alertId).sort()).toEqual([1, 2]);
  });

  it("does not resolve the AUTOPAY_SUCCEEDED row (shouldAutoClear=false)", () => {
    const ids = resolveOnSuccess(rows).map((r) => r.alertId);
    expect(ids).not.toContain(3);
  });

  it("does not resolve already-dismissed rows", () => {
    const ids = resolveOnSuccess(rows).map((r) => r.alertId);
    expect(ids).not.toContain(4);
  });

  it("returns empty when there are no active warnings", () => {
    expect(resolveOnSuccess([rows[2]])).toEqual([]);
  });
});
