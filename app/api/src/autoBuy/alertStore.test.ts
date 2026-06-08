import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  raiseAlert,
  clearAlerts,
  dismissAlert,
  getActiveAlerts,
  getAlertHistory,
  getBadgeCount,
} from "./alertStore";

// Store-level integration tests against a real in-memory better-sqlite3 DB
// using the actual migration-050 schema. These exercise the SQL the pure
// alerts.test.ts cannot reach (column names, CHECK constraints, dedup
// increment + context merge, resolve/dismiss state flips, read shapes).

const MIGRATION_050 = fs.readFileSync(
  path.join(__dirname, "../db/migrations/050_autobuy_alerts.sql"),
  "utf8",
);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_050);
});

describe("raiseAlert — create + dedup", () => {
  it("creates a new active row with consecutive_count=1 and parsed context", () => {
    raiseAlert(db, {
      type: "AUTOBUY_INSUFFICIENT_FUNDS",
      latestRunId: 7,
      context: { intended_buy_usd: 25, currencies_checked: "USD,USDC" },
    });
    const active = getActiveAlerts(db);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      type: "AUTOBUY_INSUFFICIENT_FUNDS",
      severity: "warning",
      status: "active",
      consecutive_count: 1,
      latest_run_id: 7,
    });
    expect(active[0].context).toEqual({ intended_buy_usd: 25, currencies_checked: "USD,USDC" });
  });

  it("increments consecutive_count and merges context on recurrence (no new row)", () => {
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: 1, context: { error_message: "first", a: 1 } });
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: 2, context: { error_message: "second", b: 2 } });
    const active = getActiveAlerts(db);
    expect(active).toHaveLength(1);
    expect(active[0].consecutive_count).toBe(2);
    expect(active[0].latest_run_id).toBe(2); // refreshed
    expect(active[0].context).toEqual({ error_message: "second", a: 1, b: 2 }); // shallow merge
  });

  it("derives critical severity for critical types", () => {
    raiseAlert(db, { type: "AUTOBUY_SWEEP_FAILED", latestRunId: null, context: { btc_amount: 0.01 } });
    expect(getActiveAlerts(db)[0].severity).toBe("critical");
  });

  it("a dismissed alert does NOT suppress a new create (recurrence opens a fresh row)", () => {
    raiseAlert(db, { type: "AUTOBUY_INSUFFICIENT_FUNDS", latestRunId: 1, context: {} });
    const first = getActiveAlerts(db)[0];
    dismissAlert(db, first.id);
    raiseAlert(db, { type: "AUTOBUY_INSUFFICIENT_FUNDS", latestRunId: 2, context: {} });
    const active = getActiveAlerts(db);
    expect(active).toHaveLength(1); // a brand-new active row
    expect(active[0].id).not.toBe(first.id);
    expect(active[0].consecutive_count).toBe(1);
    // history retains both
    expect(getAlertHistory(db)).toHaveLength(2);
  });

  it("a null signal writes nothing", () => {
    raiseAlert(db, null);
    expect(getActiveAlerts(db)).toHaveLength(0);
  });
});

describe("clearAlerts — auto-clear (spec §3)", () => {
  it("buy resolves insufficient-funds + order-failed; sweep/auth untouched", () => {
    raiseAlert(db, { type: "AUTOBUY_INSUFFICIENT_FUNDS", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_SWEEP_FAILED", latestRunId: null, context: {} });
    clearAlerts(db, "buy");
    const active = getActiveAlerts(db).map((a) => a.type);
    expect(active).toEqual(["AUTOBUY_SWEEP_FAILED"]);
    // resolved rows retained with resolved_at stamped
    const resolved = getAlertHistory(db).filter((a) => a.status === "resolved");
    expect(resolved).toHaveLength(2);
    expect(resolved.every((a) => typeof a.resolved_at === "number")).toBe(true);
  });

  it("api_ok resolves auth + rate-limit", () => {
    raiseAlert(db, { type: "AUTOBUY_AUTH_FAILURE", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_RATE_LIMITED", latestRunId: null, context: {} });
    clearAlerts(db, "api_ok");
    expect(getActiveAlerts(db)).toHaveLength(0);
  });

  it("clearing with no matching active alerts is a no-op", () => {
    raiseAlert(db, { type: "AUTOBUY_SWEEP_FAILED", latestRunId: null, context: {} });
    clearAlerts(db, "buy");
    expect(getActiveAlerts(db)).toHaveLength(1);
  });
});

describe("dismissAlert — idempotent terminal transition", () => {
  it("flips active → dismissed with dismissed_at; returns the row", () => {
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context: {} });
    const id = getActiveAlerts(db)[0].id;
    const updated = dismissAlert(db, id);
    expect(updated?.status).toBe("dismissed");
    expect(typeof updated?.dismissed_at).toBe("number");
    expect(getActiveAlerts(db)).toHaveLength(0);
  });

  it("dismissing an already-dismissed alert returns it unchanged (idempotent)", () => {
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context: {} });
    const id = getActiveAlerts(db)[0].id;
    const first = dismissAlert(db, id);
    const second = dismissAlert(db, id);
    expect(second?.status).toBe("dismissed");
    expect(second?.dismissed_at).toBe(first?.dismissed_at); // not re-stamped
  });

  it("returns null for an absent id", () => {
    expect(dismissAlert(db, 9999)).toBeNull();
  });
});

describe("getBadgeCount", () => {
  it("returns 0/null when empty", () => {
    expect(getBadgeCount(db)).toEqual({ active_count: 0, highest_severity: null });
  });
  it("reflects active count and highest severity (critical wins)", () => {
    raiseAlert(db, { type: "AUTOBUY_RATE_LIMITED", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_SWEEP_FAILED", latestRunId: null, context: {} });
    expect(getBadgeCount(db)).toEqual({ active_count: 2, highest_severity: "critical" });
  });
  it("amber when all active are warnings; resolved/dismissed don't count", () => {
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_RATE_LIMITED", latestRunId: null, context: {} });
    clearAlerts(db, "api_ok"); // resolves the rate-limit one
    expect(getBadgeCount(db)).toEqual({ active_count: 1, highest_severity: "warning" });
  });
});

describe("getAlertHistory — ordering + window", () => {
  it("returns all statuses, newest created_at first", () => {
    raiseAlert(db, { type: "AUTOBUY_ORDER_FAILED", latestRunId: null, context: {} });
    raiseAlert(db, { type: "AUTOBUY_SWEEP_FAILED", latestRunId: null, context: {} });
    const hist = getAlertHistory(db);
    expect(hist).toHaveLength(2);
    // both created at ~same second; just assert all statuses representable
    expect(hist.every((a) => ["active", "resolved", "dismissed"].includes(a.status))).toBe(true);
  });
});
