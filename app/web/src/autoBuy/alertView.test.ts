import { describe, it, expect } from "vitest";
import {
  deriveBadge,
  orderActiveAlerts,
  summarizeAlert,
  filterHistory,
} from "./alertView";
import type { AutoBuyAlert } from "../api/client";

// A1 pure-logic unit tests for the Auto-Buy alert view helpers (spec §7).

function alert(p: Partial<AutoBuyAlert> & { type: string }): AutoBuyAlert {
  return {
    id: p.id ?? 1,
    type: p.type,
    severity: p.severity ?? "warning",
    status: p.status ?? "active",
    consecutive_count: p.consecutive_count ?? 1,
    latest_run_id: p.latest_run_id ?? null,
    context: p.context ?? null,
    created_at: p.created_at ?? 1000,
    updated_at: p.updated_at ?? 1000,
    resolved_at: p.resolved_at ?? null,
    dismissed_at: p.dismissed_at ?? null,
  };
}

describe("deriveBadge", () => {
  it("returns null severity and 0 count for empty", () => {
    expect(deriveBadge([])).toEqual({ count: 0, severity: null });
  });
  it("counts active alerts and reflects highest severity (critical wins)", () => {
    const badge = deriveBadge([
      alert({ type: "AUTOBUY_RATE_LIMITED", severity: "warning" }),
      alert({ type: "AUTOBUY_SWEEP_FAILED", severity: "critical" }),
    ]);
    expect(badge).toEqual({ count: 2, severity: "critical" });
  });
  it("is amber when all active are warnings", () => {
    expect(deriveBadge([alert({ type: "AUTOBUY_ORDER_FAILED", severity: "warning" })]))
      .toEqual({ count: 1, severity: "warning" });
  });
  it("ignores non-active rows (resolved/dismissed don't count toward the badge)", () => {
    const badge = deriveBadge([
      alert({ type: "AUTOBUY_ORDER_FAILED", severity: "warning", status: "active" }),
      alert({ type: "AUTOBUY_SWEEP_FAILED", severity: "critical", status: "resolved" }),
      alert({ type: "AUTOBUY_AUTH_FAILURE", severity: "critical", status: "dismissed" }),
    ]);
    expect(badge).toEqual({ count: 1, severity: "warning" });
  });
});

describe("orderActiveAlerts", () => {
  it("critical before warning, then newest updated_at first", () => {
    const ordered = orderActiveAlerts([
      alert({ id: 1, type: "AUTOBUY_RATE_LIMITED", severity: "warning", updated_at: 100 }),
      alert({ id: 2, type: "AUTOBUY_SWEEP_FAILED", severity: "critical", updated_at: 50 }),
      alert({ id: 3, type: "AUTOBUY_AUTH_FAILURE", severity: "critical", updated_at: 200 }),
      alert({ id: 4, type: "AUTOBUY_ORDER_FAILED", severity: "warning", updated_at: 300 }),
    ]);
    expect(ordered.map((a) => a.id)).toEqual([3, 2, 4, 1]);
  });
  it("does not mutate the input array", () => {
    const input = [
      alert({ id: 1, type: "AUTOBUY_RATE_LIMITED", severity: "warning", updated_at: 10 }),
      alert({ id: 2, type: "AUTOBUY_SWEEP_FAILED", severity: "critical", updated_at: 20 }),
    ];
    const snapshot = input.map((a) => a.id);
    orderActiveAlerts(input);
    expect(input.map((a) => a.id)).toEqual(snapshot);
  });
});

describe("summarizeAlert", () => {
  it("insufficient-funds folds in amount + currencies checked, critical-vs-warning icon", () => {
    const s = summarizeAlert(
      alert({
        type: "AUTOBUY_INSUFFICIENT_FUNDS",
        severity: "warning",
        context: { intended_buy_usd: 25, currencies_checked: "USD,USDC" },
      }),
    );
    expect(s.icon).toBe("⚠");
    expect(s.title).toMatch(/insufficient funds/i);
    expect(s.message).toContain("$25");
    expect(s.message).toContain("USD,USDC");
  });
  it("critical types use the ✕ icon", () => {
    expect(summarizeAlert(alert({ type: "AUTOBUY_SWEEP_FAILED", severity: "critical" })).icon).toBe("✕");
    expect(summarizeAlert(alert({ type: "AUTOBUY_AUTH_FAILURE", severity: "critical" })).icon).toBe("✕");
  });
  it("sweep-failed surfaces BTC amount and error", () => {
    const s = summarizeAlert(
      alert({ type: "AUTOBUY_SWEEP_FAILED", severity: "critical", context: { btc_amount: 0.0123, error_code: "address_not_whitelisted" } }),
    );
    expect(s.message).toContain("0.0123 BTC");
    expect(s.message).toContain("address_not_whitelisted");
  });
  it("order-failed includes the consecutive_count", () => {
    const s = summarizeAlert(
      alert({ type: "AUTOBUY_ORDER_FAILED", severity: "warning", consecutive_count: 4, context: { error_message: "bad order" } }),
    );
    expect(s.message).toContain("×4");
    expect(s.message).toContain("bad order");
  });
  it("is null-safe with missing context", () => {
    const s = summarizeAlert(alert({ type: "AUTOBUY_INSUFFICIENT_FUNDS", context: null }));
    expect(s.message).toContain("the intended amount");
    expect(s.message).toContain("your selected currency");
  });
  it("falls back gracefully for an unknown type", () => {
    const s = summarizeAlert(alert({ type: "AUTOBUY_FUTURE_THING", severity: "warning" }));
    expect(s.title).toBe("AUTOBUY_FUTURE_THING");
  });
});

describe("filterHistory", () => {
  const set = [
    alert({ id: 1, type: "AUTOBUY_INSUFFICIENT_FUNDS", severity: "warning", status: "active" }),
    alert({ id: 2, type: "AUTOBUY_SWEEP_FAILED", severity: "critical", status: "resolved" }),
    alert({ id: 3, type: "AUTOBUY_ORDER_FAILED", severity: "warning", status: "dismissed" }),
    alert({ id: 4, type: "AUTOBUY_SWEEP_FAILED", severity: "critical", status: "active" }),
  ];

  it("no filters / all → returns everything", () => {
    expect(filterHistory(set, {}).map((a) => a.id)).toEqual([1, 2, 3, 4]);
    expect(filterHistory(set, { status: "all", severity: "all", type: "all" }).length).toBe(4);
  });
  it("filters by status", () => {
    expect(filterHistory(set, { status: "active" }).map((a) => a.id)).toEqual([1, 4]);
    expect(filterHistory(set, { status: "dismissed" }).map((a) => a.id)).toEqual([3]);
  });
  it("filters by severity", () => {
    expect(filterHistory(set, { severity: "critical" }).map((a) => a.id)).toEqual([2, 4]);
  });
  it("filters by type", () => {
    expect(filterHistory(set, { type: "AUTOBUY_SWEEP_FAILED" }).map((a) => a.id)).toEqual([2, 4]);
  });
  it("composes multiple filters (AND)", () => {
    expect(filterHistory(set, { status: "active", severity: "critical" }).map((a) => a.id)).toEqual([4]);
  });
});
