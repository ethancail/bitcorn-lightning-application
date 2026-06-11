// Orchestration coverage for the subscription deposit detector, per the
// 2026-06-11 discrimination audit. paymentMath.test.ts covers the pure
// decision logic; this file covers the loop + guards in detector.ts:
// the confirmation filter, the deposit-set membership check, the
// already-recorded idempotency guard (ledger AND pending), the
// empty-set / no-crash case, and end-to-end credit stacking.
//
// Test seam (no production-code change): the detector statically imports
// `../db` (opens SQLite at module load) and `../lightning/lnd` (gRPC) and
// `./btcUsdSpot` (network). We keep this file's *static* surface free of
// those — DB_DIR is pointed at a throwaway temp dir and the detector is
// pulled in via dynamic import only after env is set, mirroring the
// lazy-import discipline from payFromNode. LND + BTC/USD are mocked.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";

// Mutable holder the LND mock reads from (vi.hoisted so it exists before
// the hoisted vi.mock factory runs).
const lndState = vi.hoisted(() => ({ utxos: [] as any[] }));

// Partial-mock LND: real module (no gRPC at load), getLndUtxos returns
// our controlled set. createLndChainAddress et al. stay real but are
// never called (lnd_channels is empty → no member discovery).
vi.mock("../lightning/lnd", async (importActual) => {
  const actual = await importActual<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndUtxos: vi.fn(async () => ({ utxos: lndState.utxos })),
  };
});

// Avoid the network BTC/USD read; keep the pure satsToUsdCents real.
vi.mock("./btcUsdSpot", async (importActual) => {
  const actual = await importActual<typeof import("./btcUsdSpot")>();
  return {
    ...actual,
    fetchBtcUsdSpotCents: vi.fn(async () => 6_000_000_00), // $60k/BTC in cents
  };
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PRICE = 50_000;

// Set env BEFORE any module that touches the DB is imported.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-detector-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY =
  process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

let db: BetterSqlite3.Database;
let scanSubscriptionDeposits: typeof import("./detector").scanSubscriptionDeposits;

function seedMember(pubkey: string, depositAddress: string, paidThrough: number): void {
  db.prepare(
    `INSERT INTO subscription (
        member_pubkey, deposit_address, derivation_path,
        paid_through, created_at, current_tier
     ) VALUES (?, ?, ?, ?, ?, 'current')`,
  ).run(pubkey, depositAddress, `bitcorn:subscription:${pubkey.slice(0, 16)}`, paidThrough, paidThrough);
}

function utxo(opts: {
  address: string;
  txid: string;
  vout?: number;
  tokens?: number;
  conf?: number;
}) {
  return {
    address: opts.address,
    transaction_id: opts.txid,
    transaction_vout: opts.vout ?? 0,
    tokens: opts.tokens ?? PRICE,
    confirmation_count: opts.conf ?? 1,
    address_format: "p2wpkh",
    output_script: "00",
  };
}

function paidThroughOf(pubkey: string): number {
  const row = db
    .prepare("SELECT paid_through FROM subscription WHERE member_pubkey = ?")
    .get(pubkey) as { paid_through: number };
  return row.paid_through;
}

function paymentRowsFor(txid: string): number {
  return (
    db.prepare("SELECT COUNT(*) c FROM subscription_payment WHERE txid = ?").get(txid) as {
      c: number;
    }
  ).c;
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ scanSubscriptionDeposits } = await import("./detector"));
  // Pass the first-run gate so the scan executes (migration 036 seeds
  // the policy row with first_run_acknowledged_at NULL).
  db.prepare("UPDATE subscription_policy SET first_run_acknowledged_at = ? WHERE id = 1").run(
    Date.now(),
  );
});

beforeEach(() => {
  // Reset per-test state; keep the (acknowledged) policy row.
  db.exec(
    "DELETE FROM subscription_payment; DELETE FROM subscription_pending_attribution; DELETE FROM subscription;",
  );
  lndState.utxos = [];
});

const MEMBER = "03b2c3df7d60cd289a79aea1913dccfacbf0c133a7748fef4c2c1c0fb513ddc052";
const ADDR = "bcrt1q3qa4flznv9eda9czve2davfp6wygxu3nzt5kta";

describe("scanSubscriptionDeposits — orchestration guards (audit §3/§6/§7)", () => {
  it("happy path: confirmed exact payment to a known address credits and advances paid_through", async () => {
    const past = Date.now() - 5 * MS_PER_DAY; // lapsed → reset from now
    seedMember(MEMBER, ADDR, past);
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_happy", tokens: PRICE })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(1);
    expect(paymentRowsFor("tx_happy")).toBe(1);
    const days = Math.round((paidThroughOf(MEMBER) - Date.now()) / MS_PER_DAY);
    expect(days).toBe(30);
  });

  it("case 8: a 0-confirmation UTXO is not credited (awaits confirmation)", async () => {
    seedMember(MEMBER, ADDR, Date.now() - MS_PER_DAY);
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_unconf", conf: 0 })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(summary.pending_attribution_written).toBe(0);
    expect(paymentRowsFor("tx_unconf")).toBe(0);
  });

  it("case 9: a confirmed UTXO on an address NOT in the deposit set is ignored", async () => {
    const before = Date.now() + 10 * MS_PER_DAY;
    seedMember(MEMBER, ADDR, before);
    lndState.utxos = [utxo({ address: "bcrt1qNOTaSubscriptionAddress000000000000", txid: "tx_stray" })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(paymentRowsFor("tx_stray")).toBe(0);
    expect(paidThroughOf(MEMBER)).toBe(before); // untouched
  });

  it("case 10: empty deposit set → no attributions, no crash", async () => {
    // No subscription rows seeded.
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_nobody" })];
    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(summary.pending_attribution_written).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("case 7: the same (txid, vout) seen across two scans is credited only once", async () => {
    seedMember(MEMBER, ADDR, Date.now() - MS_PER_DAY);
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_idem", tokens: PRICE })];

    const first = await scanSubscriptionDeposits();
    const afterFirst = paidThroughOf(MEMBER);
    // UTXO still present on the next tick (not yet swept).
    const second = await scanSubscriptionDeposits();
    const afterSecond = paidThroughOf(MEMBER);

    expect(first.credits_written).toBe(1);
    expect(second.credits_written).toBe(0); // alreadyRecorded short-circuits
    expect(paymentRowsFor("tx_idem")).toBe(1); // exactly one ledger row
    expect(afterSecond).toBe(afterFirst); // paid_through advanced once, not twice
  });

  it("case 12a: a UTXO already in the credit ledger is skipped", async () => {
    seedMember(MEMBER, ADDR, Date.now() + 10 * MS_PER_DAY);
    // Pre-seed a ledger row for this exact (txid, vout).
    db.prepare(
      `INSERT INTO subscription_payment (member_pubkey, txid, vout, amount_sats, received_at, period_extension_days, kind)
       VALUES (?, 'tx_in_ledger', 0, ?, ?, 30, 'onchain')`,
    ).run(MEMBER, PRICE, Date.now());
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_in_ledger" })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(paymentRowsFor("tx_in_ledger")).toBe(1); // still just the pre-seeded row
  });

  it("case 12b: a UTXO already in the pending-attribution bucket is skipped", async () => {
    seedMember(MEMBER, ADDR, Date.now() + 10 * MS_PER_DAY);
    db.prepare(
      `INSERT INTO subscription_pending_attribution (txid, vout, amount_sats, member_pubkey, received_at, confirmed_at, reason)
       VALUES ('tx_in_pending', 0, 1000, ?, ?, ?, 'seeded')`,
    ).run(MEMBER, Date.now(), Date.now());
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_in_pending", tokens: 1000 })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(summary.pending_attribution_written).toBe(0); // not re-bucketed
    expect(
      (db.prepare("SELECT COUNT(*) c FROM subscription_pending_attribution WHERE txid = 'tx_in_pending'").get() as { c: number }).c,
    ).toBe(1);
  });

  it("underpayment below tolerance is routed to the pending bucket, not credited", async () => {
    const future = Date.now() + 10 * MS_PER_DAY;
    seedMember(MEMBER, ADDR, future);
    lndState.utxos = [utxo({ address: ADDR, txid: "tx_under", tokens: 47_499 })];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(0);
    expect(summary.pending_attribution_written).toBe(1);
    expect(paymentRowsFor("tx_under")).toBe(0);
    expect(paidThroughOf(MEMBER)).toBe(future); // untouched
  });

  it("case 5 (e2e): two distinct UTXOs (different txids) to the same address each credit and stack", async () => {
    seedMember(MEMBER, ADDR, Date.now() - MS_PER_DAY); // lapsed
    lndState.utxos = [
      utxo({ address: ADDR, txid: "tx_send_a", tokens: PRICE }),
      utxo({ address: ADDR, txid: "tx_send_b", tokens: PRICE }),
    ];

    const summary = await scanSubscriptionDeposits();
    expect(summary.credits_written).toBe(2);
    expect(paymentRowsFor("tx_send_a")).toBe(1);
    expect(paymentRowsFor("tx_send_b")).toBe(1);
    // First (lapsed) resets from now → +30d; second stacks → +60d total.
    const days = Math.round((paidThroughOf(MEMBER) - Date.now()) / MS_PER_DAY);
    expect(days).toBe(60);
  });
});
