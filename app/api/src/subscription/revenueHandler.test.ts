import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { computeSubscriptionRevenueForTreasury } from "./revenueHandler";

// Integration tests against a real in-memory better-sqlite3 DB using the
// actual migration-036 schema (subscription_policy seed included), same
// harness as autoPayAlertStore.test.ts. Exercises the SQL directly: the
// kind='onchain' filter, per-member grouping, the confirmed_at window,
// policy-driven entitlement, and the paying/enrolled counts.

const MIGRATION_036 = fs.readFileSync(
  path.join(__dirname, "../db/migrations/036_member_subscription.sql"),
  "utf8",
);

const NOW = 1_784_900_000_000; // fixed clock (ms)
const MS_PER_DAY = 86_400_000;

const A = "02aaaa";
const B = "02bbbb";
const C = "02cccc";

let db: Database.Database;

function insertMember(pubkey: string, tier: string) {
  db.prepare(
    `INSERT INTO subscription (
       member_pubkey, deposit_address, derivation_path, paid_through,
       created_at, current_tier
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(pubkey, `bcrt1q${pubkey}`, `m/84'/1'/0'/0/0`, NOW, NOW, tier);
}

let txCounter = 0;
function insertPayment(
  pubkey: string,
  opts: {
    amount_sats: number;
    usd_cents?: number | null;
    confirmed_at?: number | null;
    kind?: "onchain" | "admin_override";
  },
) {
  const kind = opts.kind ?? "onchain";
  db.prepare(
    `INSERT INTO subscription_payment (
       member_pubkey, txid, vout, amount_sats, amount_usd_cents_at_receipt,
       received_at, confirmed_at, period_extension_days, kind, admin_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pubkey,
    kind === "onchain" ? `tx${txCounter++}` : null,
    kind === "onchain" ? 0 : null,
    opts.amount_sats,
    opts.usd_cents ?? null,
    opts.confirmed_at ?? NOW,
    opts.confirmed_at === undefined ? NOW : opts.confirmed_at,
    kind === "onchain" ? 30 : 0,
    kind,
    kind === "admin_override" ? "grandfather sentinel" : null,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_036);
  txCounter = 0;
});

describe("kind='onchain' filter", () => {
  it("excludes admin_override sentinel rows from all sums and counts", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 0, kind: "admin_override" });
    insertPayment(A, { amount_sats: 50_000, usd_cents: 3_100 });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.total_earned_sats).toBe(50_000);
    expect(r.totals.payment_count).toBe(1);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]).toMatchObject({
      member_pubkey: A,
      total_sats: 50_000,
      payment_count: 1,
    });
  });

  it("a member with ONLY a sentinel row contributes no revenue row at all", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 0, kind: "admin_override" });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.members).toHaveLength(0);
    expect(r.totals.total_earned_sats).toBe(0);
    expect(r.totals.payment_count).toBe(0);
  });
});

describe("per-member grouping and ordering", () => {
  it("groups sums per member, sorted by total_sats DESC", () => {
    insertMember(A, "current");
    insertMember(B, "current");
    insertPayment(A, { amount_sats: 50_000, usd_cents: 3_100 });
    insertPayment(B, { amount_sats: 50_000, usd_cents: 3_200 });
    insertPayment(B, { amount_sats: 50_000, usd_cents: 3_300 });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.members.map((m) => m.member_pubkey)).toEqual([B, A]);
    expect(r.members[0]).toMatchObject({
      total_sats: 100_000,
      total_usd_cents: 6_500,
      payment_count: 2,
    });
    expect(r.totals.total_earned_sats).toBe(150_000);
    expect(r.totals.total_earned_usd_cents).toBe(9_600);
  });

  it("sums usd_cents as 0 when no row captured a USD price", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 50_000, usd_cents: null });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.members[0].total_usd_cents).toBe(0);
    expect(r.totals.total_earned_usd_cents).toBe(0);
  });
});

describe("recurring window (confirmed_at)", () => {
  it("counts only payments confirmed inside now − period_days", () => {
    insertMember(A, "current");
    // Inside the 30-day window.
    insertPayment(A, { amount_sats: 50_000, confirmed_at: NOW - 5 * MS_PER_DAY });
    // Outside the window — still in all-time.
    insertPayment(A, { amount_sats: 50_000, confirmed_at: NOW - 45 * MS_PER_DAY });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.window_start).toBe(NOW - 30 * MS_PER_DAY);
    expect(r.totals.recurring_actual_sats).toBe(50_000);
    expect(r.totals.total_earned_sats).toBe(100_000);
    expect(r.members[0]).toMatchObject({
      window_sats: 50_000,
      window_payment_count: 1,
      total_sats: 100_000,
      payment_count: 2,
    });
  });

  it("excludes pending rows (confirmed_at NULL) from the window but not all-time", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 50_000, confirmed_at: null });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.recurring_actual_sats).toBe(0);
    expect(r.members[0]).toMatchObject({ window_sats: 0, total_sats: 50_000 });
  });
});

describe("entitlement and member counts — paying = has actually paid", () => {
  it("a fresh-grace member (tier 'current', zero payments) is NOT paying — the previously miscounted case", () => {
    // tierDispatch stores 'current' for never-paid members inside the
    // fresh-onboarding grace window. Tier-based counting inflated
    // paying_member_count and the entitlement projection.
    insertMember(A, "current");

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(0);
    expect(r.totals.active_paid_member_count).toBe(0);
    expect(r.totals.member_count).toBe(1);
    expect(r.totals.recurring_entitlement_sats).toBe(0);
  });

  it("entitlement = active-paid members × price_sats read from subscription_policy", () => {
    // Prove the policy is read, not hardcoded: bump the seeded 50k.
    db.prepare(`UPDATE subscription_policy SET price_sats = 60000 WHERE id = 1`).run();
    insertMember(A, "current");
    insertMember(B, "current"); // enrolled, never paid → not counted
    insertMember(C, "current"); // enrolled, never paid → not counted
    insertPayment(A, { amount_sats: 60_000 });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.policy.price_sats).toBe(60_000);
    expect(r.totals.paying_member_count).toBe(1);
    expect(r.totals.active_paid_member_count).toBe(1);
    expect(r.totals.member_count).toBe(3);
    expect(r.totals.recurring_entitlement_sats).toBe(60_000);
  });

  it("a pending-only payment (confirmed_at NULL) does not count as paying", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 50_000, confirmed_at: null });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(0);
    expect(r.totals.recurring_entitlement_sats).toBe(0);
  });

  it("an admin_override-only member (grandfather sentinel) does not count as paying", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 0, kind: "admin_override" });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(0);
    expect(r.totals.recurring_entitlement_sats).toBe(0);
  });

  it("a lapsed member with a confirmed payment stays in paying_member_count but NOT the entitlement basis", () => {
    insertMember(A, "routing_lapsed");
    insertPayment(A, { amount_sats: 50_000, confirmed_at: NOW - 90 * MS_PER_DAY });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(1);
    expect(r.totals.active_paid_member_count).toBe(0);
    expect(r.totals.member_count).toBe(1);
    expect(r.totals.recurring_entitlement_sats).toBe(0);
  });

  it("entitlement basis = active AND paid: lapsed-paid and never-paid members excluded", () => {
    // A: active + paid → both counts. B: paid but lapsed → paying only.
    // C: active (fresh grace) but never paid → neither count.
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 50_000 });
    insertMember(B, "routing_lapsed");
    insertPayment(B, { amount_sats: 50_000, confirmed_at: NOW - 90 * MS_PER_DAY });
    insertMember(C, "current");

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(2);
    expect(r.totals.active_paid_member_count).toBe(1);
    expect(r.totals.member_count).toBe(3);
    expect(r.totals.recurring_entitlement_sats).toBe(50_000);
  });

  it("multiple payments by one member count that member once", () => {
    insertMember(A, "current");
    insertPayment(A, { amount_sats: 50_000 });
    insertPayment(A, { amount_sats: 50_000 });

    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.totals.paying_member_count).toBe(1);
    expect(r.totals.active_paid_member_count).toBe(1);
    expect(r.totals.recurring_entitlement_sats).toBe(50_000);
  });
});

describe("empty state", () => {
  it("returns zeros and an empty members list on a fresh DB", () => {
    const r = computeSubscriptionRevenueForTreasury(db, NOW);
    expect(r.members).toEqual([]);
    expect(r.totals).toEqual({
      total_earned_sats: 0,
      total_earned_usd_cents: 0,
      payment_count: 0,
      recurring_entitlement_sats: 0,
      recurring_actual_sats: 0,
      paying_member_count: 0,
      active_paid_member_count: 0,
      member_count: 0,
    });
    expect(r.policy).toEqual({ price_sats: 50_000, period_days: 30 });
  });
});
