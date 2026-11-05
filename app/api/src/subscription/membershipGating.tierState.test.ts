// Membership-gating slice 1 — tier state: no fresh grace (T1), the Tier 1 lock
// at + 30 (T2), and the founding-member credit (T3).
//
// Spec: bitcorn-research specs/2026-11-05-membership-gating-spec.md §1 T1–T3,
// done-whens DW1–DW4 and DW12.
//
// ⚠ THE REAL RUNNER, NOT A COPY OF IT. Every migration here runs through
// db/migrate.ts's runMigrations() against a temp-dir DB, the way a treasury
// boots. To replay the UPGRADE, a test seeds the pre-update rows, deletes
// 071/072 from the `migrations` bookkeeping table and runs the runner again:
// that is exactly what the treasury's first boot on the new image does, with
// the rows it already has.
//
// ⚠ NO LND. createLndChainAddress is the only LND call on these paths
// (allocation); it is replaced with a counter at the lnd.ts boundary.

import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-gating-tier-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  let n = 0;
  return {
    ...actual,
    createLndChainAddress: async () => ({ address: `bcrt1qtest${n++}` }),
  };
});

const M071 = "071_subscription_grace_days_worker_30.sql";
const M072 = "072_subscription_founding_member_credit.sql";
const MS_PER_DAY = 86_400_000;
const SENTINEL_REASON = "Stage 2 grandfather backfill at flip-day";

let db: Database.Database;
let runMigrations: typeof import("../db/migrate").runMigrations;
let recomputeAllTiers: typeof import("./tierDispatch").recomputeAllTiers;
let getSubscriptionPolicy: typeof import("./policy").getSubscriptionPolicy;
let issueTokenForPubkey: typeof import("./tokenIssuance").issueTokenForPubkey;
let scopeForTier: typeof import("./tokenIssuance").scopeForTier;
let computeSubscriptionStatusForPubkey: typeof import("./statusHandler").computeSubscriptionStatusForPubkey;
let backfillExistingMembers: typeof import("./backfill").backfillExistingMembers;
let computeSubscriptionRevenueForTreasury: typeof import("./revenueHandler").computeSubscriptionRevenueForTreasury;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ runMigrations } = await import("../db/migrate"));
  runMigrations();
  ({ db } = await import("../db"));
  ({ recomputeAllTiers } = await import("./tierDispatch"));
  ({ getSubscriptionPolicy } = await import("./policy"));
  ({ issueTokenForPubkey, scopeForTier } = await import("./tokenIssuance"));
  ({ computeSubscriptionStatusForPubkey } = await import("./statusHandler"));
  ({ backfillExistingMembers } = await import("./backfill"));
  ({ computeSubscriptionRevenueForTreasury } = await import("./revenueHandler"));
});

beforeEach(() => {
  db.pragma("foreign_keys = OFF");
  db.exec(`DELETE FROM subscription_payment;
           DELETE FROM subscription;
           DELETE FROM lnd_channels;
           DELETE FROM contacts;`);
  db.pragma("foreign_keys = ON");
  // The pre-update policy: migration 036's 7-day worker grace, first run acked.
  db.prepare(
    `UPDATE subscription_policy
        SET grace_days_worker = 7, period_days = 30,
            first_run_acknowledged_at = ?
      WHERE id = 1`,
  ).run(Date.now() - 200 * MS_PER_DAY);
});

/** The treasury's first boot on the new image, replayed. */
function bootTheUpdate(): void {
  db.prepare("DELETE FROM migrations WHERE id IN (?, ?)").run(M071, M072);
  runMigrations();
}

function seedRow(pubkey: string, o: { createdAt: number; paidThrough?: number; tier: string }) {
  db.prepare(
    `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path,
                               paid_through, created_at, current_tier)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(pubkey, `bcrt1q${pubkey.slice(0, 20)}`, `label-${pubkey}`, o.paidThrough ?? o.createdAt, o.createdAt, o.tier);
}

function seedSentinel(pubkey: string, at: number) {
  db.prepare(
    `INSERT INTO subscription_payment (member_pubkey, amount_sats, received_at,
                                       period_extension_days, kind, admin_reason)
     VALUES (?, 0, ?, 0, 'admin_override', ?)`,
  ).run(pubkey, at, SENTINEL_REASON);
}

function seedOnchain(pubkey: string, at: number) {
  db.prepare(
    `INSERT INTO subscription_payment (member_pubkey, txid, vout, amount_sats, received_at,
                                       confirmed_at, period_extension_days, kind)
     VALUES (?, ?, 0, 50000, ?, ?, 30, 'onchain')`,
  ).run(pubkey, `tx-${pubkey}`, at, at);
}

type PaymentRow = {
  kind: string;
  amount_sats: number;
  received_at: number;
  period_extension_days: number;
  admin_reason: string | null;
};

function payments(pubkey: string): PaymentRow[] {
  return db
    .prepare(
      `SELECT kind, amount_sats, received_at, period_extension_days, admin_reason
         FROM subscription_payment WHERE member_pubkey = ? ORDER BY id`,
    )
    .all(pubkey) as PaymentRow[];
}

function row(pubkey: string) {
  return db
    .prepare(
      `SELECT paid_through, created_at, current_tier, last_payment_at, last_payment_txid
         FROM subscription WHERE member_pubkey = ?`,
    )
    .get(pubkey) as {
    paid_through: number;
    created_at: number;
    current_tier: string;
    last_payment_at: number | null;
    last_payment_txid: string | null;
  };
}

function tierOf(pubkey: string): string {
  return row(pubkey).current_tier;
}

const GRANDFATHERED = "03" + "a1".repeat(32);
const PAID = "03" + "b2".repeat(32);
const FRESH = "03" + "c3".repeat(32);
const ALREADY_CREDITED = "03" + "d4".repeat(32);

// ─── DW12 / T2 ────────────────────────────────────────────────────────────

describe("DW12 — migration 071 moves the Tier 1 lock to + 30, guarded", () => {
  it("a policy still at 7 reads grace_days_worker = 30 after the update, updated_at bumped", () => {
    db.prepare("UPDATE subscription_policy SET updated_at = 1 WHERE id = 1").run();
    bootTheUpdate();
    const p = getSubscriptionPolicy();
    expect(p.grace_days_worker).toBe(30);
    expect(p.updated_at).toBeGreaterThan(1);
    // Routing and close are not changed (D4(a)).
    expect(p.grace_days_routing).toBe(30);
    expect(p.grace_days_close).toBe(60);
  });

  it("a value set by hand to something other than 7 is left alone", () => {
    db.prepare("UPDATE subscription_policy SET grace_days_worker = 14, updated_at = 1 WHERE id = 1").run();
    bootTheUpdate();
    const p = getSubscriptionPolicy();
    expect(p.grace_days_worker).toBe(14);
    expect(p.updated_at).toBe(1);
  });
});

// ─── DW1 / DW2 / T1 ───────────────────────────────────────────────────────

describe("DW1 — a node that has never paid gets payment scope from its first /token call", () => {
  it("self-allocation computes prepay and mints a payment-scope token at once", async () => {
    bootTheUpdate();
    const NEW = "03" + "e5".repeat(32);
    const result = await issueTokenForPubkey(NEW);
    expect(result.kind).toBe("minted");
    if (result.kind !== "minted") throw new Error("unreachable");
    expect(result.token.scope).toBe("payment");
    expect(tierOf(NEW)).toBe("prepay");
    // It can still see its deposit address: the status response carries it.
    const status = computeSubscriptionStatusForPubkey(NEW);
    expect(status.applicable).toBe(true);
    if (status.applicable !== true) throw new Error("unreachable");
    expect(status.deposit_address).toMatch(/^bcrt1qtest/);
  });
});

describe("DW2 — a member in fresh grace before the update shows prepay within one recompute", () => {
  it("a 5-day-old never-paid row stored as `current` drops to prepay on the first tick", async () => {
    const created = Date.now() - 5 * MS_PER_DAY;
    seedRow(FRESH, { createdAt: created, tier: "current" }); // what the old dispatch stored
    bootTheUpdate();
    const summary = recomputeAllTiers(getSubscriptionPolicy());
    expect(tierOf(FRESH)).toBe("prepay");
    expect(summary.transitions).toContainEqual({ member_pubkey: FRESH, from: "current", to: "prepay" });
    // Its next token is payment scope.
    const result = await issueTokenForPubkey(FRESH);
    if (result.kind !== "minted") throw new Error("unreachable");
    expect(result.token.scope).toBe("payment");
    // grace.fresh_until is still in the response, for older member nodes.
    const status = computeSubscriptionStatusForPubkey(FRESH);
    if (status.applicable !== true) throw new Error("unreachable");
    expect(status.grace.fresh_until).toBe(created + 30 * MS_PER_DAY);
  });
});

// ─── DW3 / T3 ─────────────────────────────────────────────────────────────

describe("DW3 — migration 072 credits grandfathered, sentinel-only rows", () => {
  const backfilledAt = Date.now() - 178 * MS_PER_DAY; // 2026-05-11-ish: long past 30 days

  function seedPopulation() {
    // The D2 population: sentinel only, already `prepay` under today's code (§0.2).
    seedRow(GRANDFATHERED, { createdAt: backfilledAt, tier: "prepay" });
    seedSentinel(GRANDFATHERED, backfilledAt);
    // A grandfathered member who has since paid on chain: not selected.
    seedRow(PAID, { createdAt: backfilledAt, paidThrough: Date.now() + 10 * MS_PER_DAY, tier: "current" });
    seedSentinel(PAID, backfilledAt);
    seedOnchain(PAID, Date.now() - 20 * MS_PER_DAY);
    // A fresh member with no sentinel: not selected.
    seedRow(FRESH, { createdAt: Date.now() - 40 * MS_PER_DAY, tier: "prepay" });
    // Sentinel plus an operator override that already credits time: not selected.
    seedRow(ALREADY_CREDITED, { createdAt: backfilledAt, paidThrough: Date.now() + 5 * MS_PER_DAY, tier: "current" });
    seedSentinel(ALREADY_CREDITED, backfilledAt);
    db.prepare(
      `INSERT INTO subscription_payment (member_pubkey, amount_sats, received_at,
                                         period_extension_days, kind, admin_reason)
       VALUES (?, 0, ?, 30, 'admin_override', 'manual comp')`,
    ).run(ALREADY_CREDITED, Date.now() - 25 * MS_PER_DAY);
  }

  it("writes one admin_override credit and moves paid_through to credit time + period_days", () => {
    seedPopulation();
    const t0 = Date.now();
    bootTheUpdate();
    const t1 = Date.now();

    const credit = payments(GRANDFATHERED);
    expect(credit).toHaveLength(2);
    expect(credit[0].admin_reason).toBe(SENTINEL_REASON); // sentinel unchanged
    expect(credit[1]).toMatchObject({
      kind: "admin_override",
      amount_sats: 0,
      period_extension_days: 30,
      admin_reason: "Founding member credit",
    });
    // Credit time is the migration's clock (second precision, in ms).
    expect(credit[1].received_at).toBeGreaterThanOrEqual(Math.floor(t0 / 1000) * 1000);
    expect(credit[1].received_at).toBeLessThanOrEqual(t1);
    const r = row(GRANDFATHERED);
    expect(r.paid_through).toBe(credit[1].received_at + 30 * MS_PER_DAY);
    // Item E: no on-chain payment happened, so nothing claims one.
    expect(r.last_payment_at).toBeNull();
    expect(r.last_payment_txid).toBeNull();
    // Item 3: the migration does not set current_tier; the next recompute does.
    expect(r.current_tier).toBe("prepay");
  });

  it("the first recompute after the update puts the credited row at `current`, full scope", async () => {
    seedPopulation();
    bootTheUpdate();
    recomputeAllTiers(getSubscriptionPolicy());
    expect(tierOf(GRANDFATHERED)).toBe("current");
    const result = await issueTokenForPubkey(GRANDFATHERED);
    if (result.kind !== "minted") throw new Error("unreachable");
    expect(result.token.scope).toBe("full");
    // The fresh row is not credited and is prepay.
    expect(tierOf(FRESH)).toBe("prepay");
  });

  it("at no recompute from the update on does the credited row pass through prepay or a lapsed tier", () => {
    seedPopulation();
    bootTheUpdate();
    const policy = getSubscriptionPolicy();
    const seen = new Set<string>();
    // Every tick inside the credited period — the boot recompute included.
    for (let i = 0; i < 5; i++) {
      recomputeAllTiers(policy);
      seen.add(tierOf(GRANDFATHERED));
    }
    expect([...seen]).toEqual(["current"]);
  });

  it("leaves every other row untouched: paid on chain, fresh, already credited", () => {
    seedPopulation();
    const before = [PAID, FRESH, ALREADY_CREDITED].map((pk) => ({ pk, r: row(pk), p: payments(pk) }));
    bootTheUpdate();
    for (const { pk, r, p } of before) {
      expect(row(pk)).toEqual(r);
      expect(payments(pk)).toEqual(p);
    }
  });

  it("running it a second time selects nothing", () => {
    seedPopulation();
    bootTheUpdate();
    const once = { r: row(GRANDFATHERED), p: payments(GRANDFATHERED) };
    bootTheUpdate();
    expect(row(GRANDFATHERED)).toEqual(once.r);
    expect(payments(GRANDFATHERED)).toEqual(once.p);
  });

  it("is one transaction: a failure moving paid_through leaves no credit row once the boot stops", () => {
    seedPopulation();
    const before = { r: row(GRANDFATHERED), p: payments(GRANDFATHERED) };
    // Inject a failure into the UPDATE of paid_through, AFTER the INSERT ran.
    db.exec(`CREATE TEMP TRIGGER fail_paid_through
               BEFORE UPDATE OF paid_through ON subscription
             BEGIN SELECT RAISE(ABORT, 'injected paid_through failure'); END;`);
    let openTransaction = false;
    try {
      expect(() => bootTheUpdate()).toThrow(/injected paid_through failure/);
      // A stopped boot discards the connection, and with it anything not yet
      // committed. ROLLBACK is that, in-process.
      openTransaction = db.inTransaction;
      if (openTransaction) db.exec("ROLLBACK");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS temp.fail_paid_through");
    }
    // The property: no credit row survives without its paid_through move.
    expect(payments(GRANDFATHERED)).toEqual(before.p);
    expect(row(GRANDFATHERED)).toEqual(before.r);
    // ...because the file's own BEGIN was still open when the boot threw.
    expect(openTransaction).toBe(true);
    const recorded = db.prepare("SELECT 1 FROM migrations WHERE id = ?").get(M072);
    expect(recorded).toBeUndefined();
  });

  it("the payment history shows the credit as admin_override; the revenue widget does not count it", () => {
    seedPopulation();
    bootTheUpdate();
    recomputeAllTiers(getSubscriptionPolicy());
    const revenue = computeSubscriptionRevenueForTreasury(db, Date.now());
    // PAID is the only member with an on-chain payment.
    expect(revenue.totals.paying_member_count).toBe(1);
    expect(revenue.totals.active_paid_member_count).toBe(1);
  });
});

describe("DW3 — a first-run acknowledgement after the update gives the same result (R2)", () => {
  it("backfill's grandfather mode writes the sentinel AND the credit, in step with the migration", async () => {
    bootTheUpdate();
    const NEWLY = "03" + "f6".repeat(32);
    const now = Date.now();
    db.prepare(
      `INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat,
                                 remote_balance_sat, active, private, updated_at)
       VALUES ('1x1x1', ?, 1000000, 500000, 500000, 1, 0, ?)`,
    ).run(NEWLY, now);
    db.prepare(
      `INSERT INTO contacts (pubkey, name, tags, created_at, updated_at)
       VALUES (?, 'm', 'merchant', ?, ?)`,
    ).run(NEWLY, now, now);

    const t0 = Date.now();
    const summary = await backfillExistingMembers();
    expect(summary.newly_allocated).toBe(1);

    const p = payments(NEWLY);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ kind: "admin_override", period_extension_days: 0, admin_reason: SENTINEL_REASON });
    expect(p[1]).toMatchObject({
      kind: "admin_override",
      amount_sats: 0,
      period_extension_days: 30,
      admin_reason: "Founding member credit",
    });
    expect(p[1].received_at).toBeGreaterThanOrEqual(t0);
    const r = row(NEWLY);
    expect(r.paid_through).toBe(p[1].received_at + 30 * MS_PER_DAY);
    expect(r.last_payment_at).toBeNull();

    recomputeAllTiers(getSubscriptionPolicy());
    expect(tierOf(NEWLY)).toBe("current");
    expect(scopeForTier(tierOf(NEWLY))).toBe("full");
  });
});

// ─── DW4 / T2 ─────────────────────────────────────────────────────────────

describe("DW4 — a paid member stays current until paid_through + 30d", () => {
  it("current at + 29d, routing_lapsed past + 30d; worker_until reads paid_through + 30d", () => {
    bootTheUpdate();
    const IN_GRACE = "03" + "07".repeat(32);
    const PAST = "03" + "08".repeat(32);
    const ptIn = Date.now() - 29 * MS_PER_DAY;
    const ptPast = Date.now() - 31 * MS_PER_DAY;
    seedRow(IN_GRACE, { createdAt: ptIn - 60 * MS_PER_DAY, paidThrough: ptIn, tier: "current" });
    seedOnchain(IN_GRACE, ptIn - 30 * MS_PER_DAY);
    seedRow(PAST, { createdAt: ptPast - 60 * MS_PER_DAY, paidThrough: ptPast, tier: "current" });
    seedOnchain(PAST, ptPast - 30 * MS_PER_DAY);

    recomputeAllTiers(getSubscriptionPolicy());
    expect(tierOf(IN_GRACE)).toBe("current");
    expect(scopeForTier(tierOf(IN_GRACE))).toBe("full");
    // worker_lapsed is unreachable under worker = routing = 30 (R3).
    expect(tierOf(PAST)).toBe("routing_lapsed");
    expect(scopeForTier(tierOf(PAST))).toBe("payment");

    const status = computeSubscriptionStatusForPubkey(IN_GRACE);
    if (status.applicable !== true) throw new Error("unreachable");
    expect(status.grace.worker_until).toBe(ptIn + 30 * MS_PER_DAY);
  });
});
