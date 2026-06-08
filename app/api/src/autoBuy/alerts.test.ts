import { describe, it, expect } from "vitest";
import {
  classifyCoinbaseError,
  decideAlertForFailure,
  updateAlertOnSuccess,
  mergeContext,
  SEVERITY_BY_TYPE,
  type ActiveAlertRow,
  type FailureSignal,
  type AlertType,
} from "./alerts";

// Spec §7 — pure alert logic, tested in isolation (no DB, no Coinbase).

describe("classifyCoinbaseError", () => {
  it("maps 401/403 to auth", () => {
    expect(classifyCoinbaseError(401, "unauthorized")).toBe("auth");
    expect(classifyCoinbaseError(403, "forbidden")).toBe("auth");
  });
  it("maps 429 to rate_limit", () => {
    expect(classifyCoinbaseError(429, "too many requests")).toBe("rate_limit");
  });
  it("maps all 5xx to rate_limit", () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect(classifyCoinbaseError(s, "server error")).toBe("rate_limit");
    }
  });
  it("maps 400/404 and other client errors to other", () => {
    expect(classifyCoinbaseError(400, "bad request")).toBe("other");
    expect(classifyCoinbaseError(404, "not found")).toBe("other");
    expect(classifyCoinbaseError(422, "unprocessable")).toBe("other");
  });
  it("maps status 0 (timeout/abort/network) to other", () => {
    expect(classifyCoinbaseError(0, "timeout_after_30000ms")).toBe("other");
  });
  it("handles garbage/empty error text deterministically (status drives it)", () => {
    expect(classifyCoinbaseError(401, "")).toBe("auth");
    expect(classifyCoinbaseError(503, "")).toBe("rate_limit");
    expect(classifyCoinbaseError(200, "no_order_id_in_response")).toBe("other");
  });
});

describe("SEVERITY_BY_TYPE — each scenario maps to its §2 severity", () => {
  it("warnings", () => {
    expect(SEVERITY_BY_TYPE.AUTOBUY_INSUFFICIENT_FUNDS).toBe("warning");
    expect(SEVERITY_BY_TYPE.AUTOBUY_RATE_LIMITED).toBe("warning");
    expect(SEVERITY_BY_TYPE.AUTOBUY_ORDER_FAILED).toBe("warning");
  });
  it("criticals", () => {
    expect(SEVERITY_BY_TYPE.AUTOBUY_AUTH_FAILURE).toBe("critical");
    expect(SEVERITY_BY_TYPE.AUTOBUY_SWEEP_FAILED).toBe("critical");
  });
});

function active(rows: Array<Partial<ActiveAlertRow> & { type: string }>): ActiveAlertRow[] {
  return rows.map((r, i) => ({
    id: r.id ?? i + 1,
    type: r.type,
    status: r.status ?? "active",
    consecutive_count: r.consecutive_count ?? 1,
  }));
}

function signal(type: AlertType, latestRunId: number | null = null): FailureSignal {
  return { type, latestRunId, context: { k: "v" } };
}

describe("decideAlertForFailure — create-or-dedup (spec §2)", () => {
  it("creates when no active alert of the type exists", () => {
    const intent = decideAlertForFailure(signal("AUTOBUY_INSUFFICIENT_FUNDS", 7), []);
    expect(intent.action).toBe("create");
    if (intent.action === "create") {
      expect(intent.type).toBe("AUTOBUY_INSUFFICIENT_FUNDS");
      expect(intent.severity).toBe("warning");
      expect(intent.latestRunId).toBe(7);
      expect(intent.context).toEqual({ k: "v" });
    }
  });

  it("increments when an active alert of the type exists (refresh run id/context)", () => {
    const existing = active([{ id: 42, type: "AUTOBUY_ORDER_FAILED", consecutive_count: 3 }]);
    const intent = decideAlertForFailure(signal("AUTOBUY_ORDER_FAILED", 9), existing);
    expect(intent.action).toBe("increment");
    if (intent.action === "increment") {
      expect(intent.alertId).toBe(42);
      expect(intent.latestRunId).toBe(9);
      expect(intent.context).toEqual({ k: "v" });
    }
  });

  it("derives critical severity on create for critical types", () => {
    const intent = decideAlertForFailure(signal("AUTOBUY_SWEEP_FAILED"), []);
    expect(intent.action).toBe("create");
    if (intent.action === "create") expect(intent.severity).toBe("critical");
  });

  it("a DISMISSED alert of the type does NOT suppress a create (recurrence opens a new row)", () => {
    const dismissed = active([{ id: 5, type: "AUTOBUY_INSUFFICIENT_FUNDS", status: "dismissed" }]);
    // listActiveAlertRows only returns status='active', but defend against a
    // non-active row leaking in — it must not be treated as a dedup target.
    const intent = decideAlertForFailure(signal("AUTOBUY_INSUFFICIENT_FUNDS"), dismissed);
    expect(intent.action).toBe("create");
  });

  it("a RESOLVED alert of the type does NOT suppress a create", () => {
    const resolved = active([{ id: 6, type: "AUTOBUY_SWEEP_FAILED", status: "resolved" }]);
    const intent = decideAlertForFailure(signal("AUTOBUY_SWEEP_FAILED"), resolved);
    expect(intent.action).toBe("create");
  });

  it("dedup is per-type: an active alert of a different type does not match", () => {
    const other = active([{ id: 1, type: "AUTOBUY_RATE_LIMITED" }]);
    const intent = decideAlertForFailure(signal("AUTOBUY_AUTH_FAILURE"), other);
    expect(intent.action).toBe("create");
  });

  it("returns noop for an excluded/absent signal (null)", () => {
    expect(decideAlertForFailure(null, []).action).toBe("noop");
    expect(decideAlertForFailure(null, active([{ id: 1, type: "AUTOBUY_ORDER_FAILED" }])).action).toBe("noop");
  });
});

describe("updateAlertOnSuccess — auto-clear table (spec §3)", () => {
  const all = active([
    { id: 1, type: "AUTOBUY_INSUFFICIENT_FUNDS" },
    { id: 2, type: "AUTOBUY_AUTH_FAILURE" },
    { id: 3, type: "AUTOBUY_RATE_LIMITED" },
    { id: 4, type: "AUTOBUY_ORDER_FAILED" },
    { id: 5, type: "AUTOBUY_SWEEP_FAILED" },
  ]);

  it("buy resolves insufficient-funds + order-failed only", () => {
    const ids = updateAlertOnSuccess("buy", all).map((r) => r.alertId).sort();
    expect(ids).toEqual([1, 4]);
  });
  it("api_ok resolves auth + rate-limit only", () => {
    const ids = updateAlertOnSuccess("api_ok", all).map((r) => r.alertId).sort();
    expect(ids).toEqual([2, 3]);
  });
  it("sweep resolves sweep-failed only", () => {
    const ids = updateAlertOnSuccess("sweep", all).map((r) => r.alertId);
    expect(ids).toEqual([5]);
  });
  it("non-matching success is a no-op (no active alerts of that kind)", () => {
    const onlySweep = active([{ id: 9, type: "AUTOBUY_SWEEP_FAILED" }]);
    expect(updateAlertOnSuccess("buy", onlySweep)).toEqual([]);
    expect(updateAlertOnSuccess("api_ok", onlySweep)).toEqual([]);
  });
  it("ignores non-active rows", () => {
    const mixed = active([
      { id: 1, type: "AUTOBUY_INSUFFICIENT_FUNDS", status: "dismissed" },
      { id: 2, type: "AUTOBUY_ORDER_FAILED", status: "active" },
    ]);
    expect(updateAlertOnSuccess("buy", mixed).map((r) => r.alertId)).toEqual([2]);
  });
});

describe("mergeContext — shallow merge, null-safe", () => {
  it("merges new over existing", () => {
    expect(mergeContext('{"a":1,"b":2}', { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });
  it("treats null/invalid existing JSON as empty base", () => {
    expect(mergeContext(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeContext("not json", { a: 1 })).toEqual({ a: 1 });
    expect(mergeContext("[1,2,3]", { a: 1 })).toEqual({ a: 1 }); // array → not an object base
  });
});
