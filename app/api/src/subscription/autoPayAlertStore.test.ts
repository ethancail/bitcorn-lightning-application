import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  recordAutoPayFailure,
  recordAutoPaySuccess,
  getActiveAlerts,
  getAlertHistory,
  getBadgeCount,
  dismissAlert,
  resolveStaleSucceeded,
  recordCauseAlert,
  resolveClearedCauseAlerts,
} from "./autoPayAlertStore";

// Store-level integration tests against a real in-memory better-sqlite3 DB
// using the actual migration-052 schema (051 first, since 052 ALTERs
// member_profile). Exercises the SQL the pure autoPayAlerts.test.ts cannot
// reach: member_pubkey scoping, CHECK constraints, dedup increment + context
// merge, resolve-on-success, the SUCCEEDED sweep, dismiss, and read shapes.

const MIGRATION_051 = fs.readFileSync(
  path.join(__dirname, "../db/migrations/051_member_profile.sql"),
  "utf8",
);
const MIGRATION_052 = fs.readFileSync(
  path.join(__dirname, "../db/migrations/052_subscription_autopay.sql"),
  "utf8",
);

const A = "02aaaa";
const B = "02bbbb";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_051);
  db.exec(MIGRATION_052);
});

describe("recordAutoPayFailure — create + dedup, member-scoped", () => {
  it("creates a warning row with consecutive_count=1 and parsed context", () => {
    recordAutoPayFailure(db, A, {
      type: "AUTOPAY_INSUFFICIENT_FUNDS",
      context: { error_code: "insufficient_funds", balance_sats: 100 },
    });
    const active = getActiveAlerts(db, A);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      member_pubkey: A,
      type: "AUTOPAY_INSUFFICIENT_FUNDS",
      severity: "warning",
      status: "active",
      consecutive_count: 1,
    });
    expect(active[0].context).toEqual({ error_code: "insufficient_funds", balance_sats: 100 });
  });

  it("increments + merges context on recurrence of the same type (no new row)", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: { detail: "first", a: 1 } });
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: { detail: "second", b: 2 } });
    const active = getActiveAlerts(db, A);
    expect(active).toHaveLength(1);
    expect(active[0].consecutive_count).toBe(2);
    expect(active[0].context).toEqual({ detail: "second", a: 1, b: 2 });
  });

  it("does not leak alerts across members", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_LND_UNAVAILABLE", context: {} });
    expect(getActiveAlerts(db, A)).toHaveLength(1);
    expect(getActiveAlerts(db, B)).toHaveLength(0);
  });

  it("opens a fresh row after dismissal (a dismissed failure cannot be permanently silenced)", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    const first = getActiveAlerts(db, A)[0];
    dismissAlert(db, A, first.id);
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    const active = getActiveAlerts(db, A);
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(first.id);
  });

  it("ignores a null signal (the classifier's defer cases)", () => {
    recordAutoPayFailure(db, A, null);
    expect(getActiveAlerts(db, A)).toHaveLength(0);
  });
});

describe("recordAutoPaySuccess — resolve warnings + raise SUCCEEDED", () => {
  it("resolves active warnings and creates an info SUCCEEDED alert", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_INSUFFICIENT_FUNDS", context: {} });
    recordAutoPaySuccess(db, A, { txid: "deadbeef", price_sats: 50000 });
    const active = getActiveAlerts(db, A);
    // the warning is resolved (no longer active); SUCCEEDED remains active
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ type: "AUTOPAY_SUCCEEDED", severity: "info" });
    expect(active[0].context).toEqual({ txid: "deadbeef", price_sats: 50000 });
    // history retains the resolved warning
    const history = getAlertHistory(db, A);
    const warn = history.find((a) => a.type === "AUTOPAY_INSUFFICIENT_FUNDS");
    expect(warn?.status).toBe("resolved");
  });
});

describe("getBadgeCount — info|warning|null severity domain", () => {
  it("returns null when there are no active alerts", () => {
    expect(getBadgeCount(db, A)).toEqual({ active_count: 0, highest_severity: null });
  });

  it("returns warning (outranking info) when an active warning coexists with a SUCCEEDED", () => {
    // success first (SUCCEEDED info active), then a later-tick failure (warning).
    // A failure does NOT resolve SUCCEEDED, so both are active.
    recordAutoPaySuccess(db, A, { txid: "x", price_sats: 1 });
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    expect(getBadgeCount(db, A)).toEqual({ active_count: 2, highest_severity: "warning" });
  });

  it("returns info when only a SUCCEEDED is active", () => {
    recordAutoPaySuccess(db, A, { txid: "x", price_sats: 1 });
    expect(getBadgeCount(db, A)).toEqual({ active_count: 1, highest_severity: "info" });
  });
});

describe("dismissAlert — flip active→dismissed, idempotent, member-scoped", () => {
  it("dismisses an active alert and returns the updated row", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    const id = getActiveAlerts(db, A)[0].id;
    const row = dismissAlert(db, A, id);
    expect(row?.status).toBe("dismissed");
    expect(getActiveAlerts(db, A)).toHaveLength(0);
  });

  it("is idempotent and returns the row unchanged on a second dismiss", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    const id = getActiveAlerts(db, A)[0].id;
    dismissAlert(db, A, id);
    const again = dismissAlert(db, A, id);
    expect(again?.status).toBe("dismissed");
  });

  it("will not dismiss another member's alert", () => {
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    const id = getActiveAlerts(db, A)[0].id;
    expect(dismissAlert(db, B, id)).toBeNull();
    expect(getActiveAlerts(db, A)).toHaveLength(1);
  });
});

describe("resolveStaleSucceeded — the 24h SUCCEEDED auto-resolve sweep", () => {
  it("resolves active SUCCEEDED rows older than the cutoff, leaving warnings", () => {
    recordAutoPaySuccess(db, A, { txid: "x", price_sats: 1 });
    recordAutoPayFailure(db, A, { type: "AUTOPAY_PAYMENT_FAILED", context: {} });
    // backdate the SUCCEEDED row well past any cutoff
    db.prepare(
      `UPDATE subscription_autopay_alerts SET updated_at = 1 WHERE type = 'AUTOPAY_SUCCEEDED'`,
    ).run();
    resolveStaleSucceeded(db, A, 1000); // cutoff far in the future relative to updated_at=1
    const active = getActiveAlerts(db, A);
    expect(active.map((a) => a.type)).toEqual(["AUTOPAY_PAYMENT_FAILED"]);
  });
});

// pay-from-node, ruled 2026-11-05 (spec §4.3).
describe("the guard alerts — once per cause, resolved when it clears", () => {
  const PRICE = "AUTOPAY_PRICE_NOT_ACKNOWLEDGED" as const;
  const count = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM subscription_autopay_alerts WHERE member_pubkey = ?").get(A) as { n: number }).n;

  it("creates one warning row carrying its cause key", () => {
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: { reason: "price_above_acknowledged" } });
    const [row] = getActiveAlerts(db, A);
    expect(row).toMatchObject({ type: PRICE, severity: "warning", consecutive_count: 1 });
    expect(row!.context).toMatchObject({ reason: "price_above_acknowledged", cause_key: "k1" });
  });

  it("C16: the same cause again does nothing — not while active, and not after dismissal", () => {
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: {} });
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: {} });
    expect(count()).toBe(1);
    const [row] = getActiveAlerts(db, A);
    dismissAlert(db, A, row!.id);
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: {} });
    expect(count()).toBe(1);
    expect(getActiveAlerts(db, A)).toHaveLength(0);
  });

  it("C16 permitting: a new cause raises a new row", () => {
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: {} });
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k2", context: {} });
    expect(count()).toBe(2);
  });

  it("C17: resolves the active row whose cause is no longer live, and keeps a live one", () => {
    recordCauseAlert(db, A, { type: PRICE, causeKey: "gone", context: {} });
    recordCauseAlert(db, A, { type: PRICE, causeKey: "live", context: {} });
    resolveClearedCauseAlerts(db, A, PRICE, new Set(["live"]));
    const active = getActiveAlerts(db, A);
    expect(active).toHaveLength(1);
    expect(active[0]!.context).toMatchObject({ cause_key: "live" });
  });

  it("is member-scoped", () => {
    recordCauseAlert(db, A, { type: PRICE, causeKey: "k1", context: {} });
    recordCauseAlert(db, B, { type: PRICE, causeKey: "k1", context: {} });
    expect(getActiveAlerts(db, B)).toHaveLength(1);
  });
});
