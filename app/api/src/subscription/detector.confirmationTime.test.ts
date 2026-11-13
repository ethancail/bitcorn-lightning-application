// recredit-check — negative controls for crediting from the deposit output's
// confirmation time (bitcorn-research specs/2026-11-13-recredit-check-credit-
// from-confirmation-time-spec.md §9, rulings O1–O7 §15, G1–G3 §15.1).
//
// ⚠ WRITTEN AGAINST THE UNFIXED DETECTOR FIRST. Each control's "Today" colour
// in the spec was observed on the base commit before any production change;
// the observed colours are in the PR body. A "red today" control that came up
// green would have proved nothing and stopped the work.
//
// Shape, per spec §9 "Shared setup":
//  - a real temp SQLite DB, migrated, as detector.test.ts builds it;
//  - LND doubled one level above ln-service: getLndUtxos plus the time source
//    (tip via getLndInfo, the windowed chain-transactions read, the header by
//    hash, getBlock as the fallback), all answered by a fake chain whose
//    headers are REAL 80-byte headers (__fixtures__/fakeChain.ts);
//  - a controllable wall clock: fake timers on Date only;
//  - "copy / restore / reopen" = close the handle, copy the main file with any
//    -wal / -shm after a TRUNCATE checkpoint, and re-import the modules over
//    the same DB_DIR (vi.resetModules), which is also what "an API restart"
//    means for the in-memory alert snapshot.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { makeBlock, type FakeBlock } from "./__fixtures__/fakeChain";

// ─── the fake chain the LND doubles read ─────────────────────────────────────

const chain = vi.hoisted(() => ({
  tip: 1_000,
  utxos: [] as any[],
  /** txid → its confirming block. */
  txs: new Map<string, { height: number; hash: string }>(),
  /** block hash → raw header hex. */
  headers: new Map<string, string>(),
  /** Block hashes whose header AND getBlock calls throw: "the source fails". */
  broken: new Set<string>(),
  /** Runs inside the windowed chain-transactions double, i.e. between the time lookup and the credit. */
  onLookup: null as null | (() => void),
  /** Ledger row count observed at each header call (ordering control). */
  rowsAtHeaderCall: [] as number[],
  countRows: null as null | (() => number),
  /** Holds the confirmation-time lookup open until released (control (x)). */
  lookupGate: null as null | Promise<void>,
  /** Windowed chain-transactions lookups made, and for which txids. */
  lookupCalls: 0,
}));

vi.mock("../lightning/lnd", async (importActual) => {
  const actual = await importActual<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndUtxos: vi.fn(async () => ({ utxos: chain.utxos })),
    getLndInfo: vi.fn(async () => ({ block_height: chain.tip, synced_to_chain: true })),
    getLndChainTransactionsAfter: vi.fn(async (afterHeight: number) => {
      chain.lookupCalls++;
      if (chain.lookupGate) await chain.lookupGate;
      chain.onLookup?.();
      const transactions = [...chain.txs.entries()]
        .filter(([, b]) => afterHeight < 1 || b.height > afterHeight)
        .map(([id, b]) => ({
          id,
          block_id: b.hash,
          confirmation_height: b.height,
          confirmation_count: chain.tip - b.height + 1,
          is_confirmed: true,
          is_outgoing: false,
          created_at: new Date(0).toISOString(),
          output_addresses: [],
          tokens: 0,
        }));
      return { transactions };
    }),
    getLndBlockHeader: vi.fn(async (hash: string) => {
      if (chain.countRows) chain.rowsAtHeaderCall.push(chain.countRows());
      if (chain.broken.has(hash)) throw new Error("UnexpectedErrorWhenGettingBlockHeader (test double)");
      const header = chain.headers.get(hash);
      if (!header) throw new Error("BlockForHeaderNotFound (test double)");
      return { header };
    }),
    getLndBlock: vi.fn(async (hash: string) => {
      if (chain.broken.has(hash)) throw new Error("UnexpectedErrorGettingBlock (test double)");
      const header = chain.headers.get(hash);
      if (!header) throw new Error("BlockNotFound (test double)");
      return { block: header + "01" + "00".repeat(60) };
    }),
    // getTreasuryAlerts()'s other non-DB input: a funded treasury.
    getLndChainBalance: vi.fn(async () => ({ chain_balance: 1_000_000_000 })),
  };
});

vi.mock("./btcUsdSpot", async (importActual) => {
  const actual = await importActual<typeof import("./btcUsdSpot")>();
  return { ...actual, fetchBtcUsdSpotCents: vi.fn(async () => 6_000_000_00) };
});

vi.mock("../lightning/loop", async (importActual) => {
  const actual = await importActual<typeof import("../lightning/loop")>();
  return { ...actual, isLoopAvailable: vi.fn(async () => ({ available: true, version: "test" })) };
});

vi.mock("../lightning/lndProbeRoute", async (importActual) => {
  const actual = await importActual<typeof import("../lightning/lndProbeRoute")>();
  return {
    ...actual,
    runTimeoutBoundLndProbe: vi.fn(async () => {
      throw new Error("probe must not run: the chain-balance double never fails");
    }),
  };
});

// ─── DB + module lifecycle ───────────────────────────────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const PRICE = 50_000;
const ALERT = "SUBSCRIPTION_PAYMENT_UNCREDITED";
const HEADING = "Subscription payments not credited yet";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-recredit-"));
const SNAP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-recredit-snap-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");
const DB_FILES = ["bitcorn.sqlite", "bitcorn.sqlite-wal", "bitcorn.sqlite-shm"];

let db: BetterSqlite3.Database;
let scanSubscriptionDeposits: typeof import("./detector").scanSubscriptionDeposits;
let getTreasuryAlerts: typeof import("../api/treasury-alerts").getTreasuryAlerts;
let defaultPeriodDays = 30;

/** A fresh module import over the same DB_DIR: what an API restart is. */
async function reopen(): Promise<void> {
  vi.resetModules();
  ({ db } = await import("../db"));
  ({ scanSubscriptionDeposits } = await import("./detector"));
  ({ getTreasuryAlerts } = await import("../api/treasury-alerts"));
}

function closeDb(): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

async function snapshot(): Promise<void> {
  closeDb();
  for (const f of fs.readdirSync(SNAP_DIR)) fs.rmSync(path.join(SNAP_DIR, f));
  for (const f of DB_FILES) {
    const src = path.join(TMP_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SNAP_DIR, f));
  }
  await reopen();
}

async function restore(): Promise<void> {
  closeDb();
  for (const f of DB_FILES) fs.rmSync(path.join(TMP_DIR, f), { force: true });
  for (const f of DB_FILES) {
    const src = path.join(SNAP_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP_DIR, f));
  }
  await reopen();
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  await reopen();
  db.prepare("UPDATE subscription_policy SET first_run_acknowledged_at = ? WHERE id = 1").run(Date.now());
  defaultPeriodDays = (db.prepare("SELECT period_days FROM subscription_policy WHERE id = 1").get() as {
    period_days: number;
  }).period_days;
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  db.exec(
    "DELETE FROM subscription_payment; DELETE FROM subscription_pending_attribution; DELETE FROM subscription;",
  );
  db.prepare(
    "UPDATE subscription_policy SET period_days = ?, first_run_acknowledged_at = COALESCE(first_run_acknowledged_at, ?) WHERE id = 1",
  ).run(defaultPeriodDays, Date.now());
  chain.tip = 1_000;
  chain.utxos = [];
  chain.txs.clear();
  chain.headers.clear();
  chain.broken.clear();
  chain.onLookup = null;
  chain.rowsAtHeaderCall = [];
  chain.countRows = null;
  chain.lookupGate = null;
  chain.lookupCalls = 0;
  db.exec("DROP TRIGGER IF EXISTS temp.force_write_error");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0); // whole seconds
const MEMBER = "03b2c3df7d60cd289a79aea1913dccfacbf0c133a7748fef4c2c1c0fb513ddc052";
const ADDR = "bcrt1q3qa4flznv9eda9czve2davfp6wygxu3nzt5kta";
const MEMBER2 = "02" + "c7".repeat(32);
const ADDR2 = "bcrt1qrecreditsecondmember00000000000000000";
const TXA = "aa".repeat(32);
const TXB = "bb".repeat(32);

function seedMember(pubkey: string, address: string, paidThrough: number): void {
  db.prepare(
    `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier)
     VALUES (?, ?, ?, ?, ?, 'current')`,
  ).run(pubkey, address, `bitcorn:subscription:${pubkey.slice(0, 16)}`, paidThrough, paidThrough);
}

/** Confirm `txid` in a block at `height` stamped `timeMs`; returns the block. */
function confirm(txid: string, height: number, timeMs: number): FakeBlock {
  const block = makeBlock(height, timeMs);
  chain.headers.set(block.hash, block.header);
  chain.txs.set(txid, { height, hash: block.hash });
  return block;
}

/** The UTXO set LND reports, with confirmation counts derived from the tip. */
function setUtxos(list: Array<{ txid: string; vout?: number; address: string; tokens?: number }>): void {
  chain.utxos = list.map((u) => {
    const b = chain.txs.get(u.txid);
    if (!b) throw new Error(`test bug: ${u.txid} not confirmed`);
    return {
      address: u.address,
      transaction_id: u.txid,
      transaction_vout: u.vout ?? 0,
      tokens: u.tokens ?? PRICE,
      confirmation_count: chain.tip - b.height + 1,
      address_format: "p2wpkh",
      output_script: "00",
    };
  });
}

function paidThroughOf(pubkey: string): number {
  return (db.prepare("SELECT paid_through FROM subscription WHERE member_pubkey = ?").get(pubkey) as {
    paid_through: number;
  }).paid_through;
}

function ledgerRows(txid: string, vout = 0): number {
  return (db.prepare("SELECT COUNT(*) c FROM subscription_payment WHERE txid = ? AND vout = ?").get(txid, vout) as {
    c: number;
  }).c;
}

function setPeriodDays(days: number): void {
  db.prepare("UPDATE subscription_policy SET period_days = ? WHERE id = 1").run(days);
}

async function uncreditedAlerts() {
  return (await getTreasuryAlerts()).filter((a) => a.type === ALERT);
}

function warnsNaming(text: string): number {
  return warnSpy.mock.calls.filter((args) => args.map(String).join(" ").includes(text)).length;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("environment", () => {
  it("runs under Node 20 (the verify gate and CI both pin it)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("§9 controls — replay and order", () => {
  it("(i) credit one output, reopen the DB, scan again: one ledger row, paid_through unchanged", async () => {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    vi.setSystemTime(T0 + MS_PER_HOUR);

    await scanSubscriptionDeposits();
    const p1 = paidThroughOf(MEMBER);
    closeDb();
    await reopen();
    await scanSubscriptionDeposits();

    expect(ledgerRows(TXA)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(p1);
  });

  it("(ii) paid up at T_conf, lapsed at the replay: restore + replay reproduces P1 = P0 + days", async () => {
    const P0 = T0 + 2 * MS_PER_DAY; // paid up at T_conf = T0
    seedMember(MEMBER, ADDR, P0);
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    await snapshot();

    vi.setSystemTime(T0 + MS_PER_HOUR);
    await scanSubscriptionDeposits();
    const P1 = paidThroughOf(MEMBER);
    expect(P1).toBe(P0 + 30 * MS_PER_DAY);

    await restore();
    vi.setSystemTime(P0 + MS_PER_DAY); // the wall clock is now past P0
    await scanSubscriptionDeposits();

    expect(ledgerRows(TXA)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(P1);
  });

  it("(ii-0) guard: as (ii), but the wall clock stays before P0 at the replay", async () => {
    const P0 = T0 + 2 * MS_PER_DAY;
    seedMember(MEMBER, ADDR, P0);
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    await snapshot();

    vi.setSystemTime(T0 + MS_PER_HOUR);
    await scanSubscriptionDeposits();
    const P1 = paidThroughOf(MEMBER);

    await restore();
    vi.setSystemTime(T0 + MS_PER_DAY); // still before P0
    await scanSubscriptionDeposits();

    expect(ledgerRows(TXA)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(P1);
  });

  it("(iii) lapsed at T_conf: first credit gives T_conf + days, and a replay a day later reproduces it", async () => {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY); // lapsed at T_conf
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    await snapshot();

    vi.setSystemTime(T0 + MS_PER_HOUR);
    await scanSubscriptionDeposits();
    const P1 = paidThroughOf(MEMBER);
    expect(P1).toBe(T0 + 30 * MS_PER_DAY);

    await restore();
    vi.setSystemTime(T0 + MS_PER_DAY + MS_PER_HOUR);
    await scanSubscriptionDeposits();

    expect(ledgerRows(TXA)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(P1);
  });

  it("(iv) two outputs reported B-first fold in ascending height: D0 + 20 d", async () => {
    setPeriodDays(5);
    const D0 = T0;
    seedMember(MEMBER, ADDR, D0);
    confirm(TXA, 1_000, D0 + 10 * MS_PER_DAY);
    confirm(TXB, 1_002, D0 + 12 * MS_PER_DAY);
    chain.tip = 1_010;
    setUtxos([
      { txid: TXB, address: ADDR },
      { txid: TXA, address: ADDR },
    ]);
    vi.setSystemTime(D0 + 12 * MS_PER_DAY + MS_PER_HOUR);

    await scanSubscriptionDeposits();

    expect(ledgerRows(TXA)).toBe(1);
    expect(ledgerRows(TXB)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(D0 + 20 * MS_PER_DAY);
  });

  it("(iv-r) a snapshot after A only, restored, replays B to D0 + 20 d", async () => {
    setPeriodDays(5);
    const D0 = T0;
    seedMember(MEMBER, ADDR, D0);
    confirm(TXA, 1_000, D0 + 10 * MS_PER_DAY);
    chain.tip = 1_000;
    setUtxos([{ txid: TXA, address: ADDR }]);
    vi.setSystemTime(D0 + 10 * MS_PER_DAY + MS_PER_HOUR);
    await scanSubscriptionDeposits(); // A credited
    await snapshot(); // ledger {A}

    confirm(TXB, 1_002, D0 + 12 * MS_PER_DAY);
    chain.tip = 1_010;
    setUtxos([
      { txid: TXB, address: ADDR },
      { txid: TXA, address: ADDR },
    ]);
    vi.setSystemTime(D0 + 12 * MS_PER_DAY + MS_PER_HOUR);
    await scanSubscriptionDeposits(); // B credited
    const beforeRestore = paidThroughOf(MEMBER);

    await restore();
    vi.setSystemTime(D0 + 30 * MS_PER_DAY);
    await scanSubscriptionDeposits(); // B replayed

    expect(ledgerRows(TXA)).toBe(1);
    expect(ledgerRows(TXB)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(D0 + 20 * MS_PER_DAY);
    expect(paidThroughOf(MEMBER)).toBe(beforeRestore);
  });

  it("(vii) the time source fails for a member's first output: neither is credited, one warning; next tick both, as (iv)", async () => {
    setPeriodDays(5);
    const D0 = T0;
    seedMember(MEMBER, ADDR, D0);
    const a = confirm(TXA, 1_000, D0 + 10 * MS_PER_DAY);
    confirm(TXB, 1_002, D0 + 12 * MS_PER_DAY);
    chain.tip = 1_010;
    setUtxos([
      { txid: TXB, address: ADDR },
      { txid: TXA, address: ADDR },
    ]);
    chain.broken.add(a.hash);
    vi.setSystemTime(D0 + 12 * MS_PER_DAY + MS_PER_HOUR);

    await scanSubscriptionDeposits();
    expect(ledgerRows(TXA)).toBe(0);
    expect(ledgerRows(TXB)).toBe(0);
    expect(warnsNaming(`${TXA}:0`)).toBe(1);

    chain.broken.clear();
    await scanSubscriptionDeposits();
    expect(ledgerRows(TXA)).toBe(1);
    expect(ledgerRows(TXB)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(D0 + 20 * MS_PER_DAY);
  });
});

describe("§9 (viii) — the alert, the time source failing", () => {
  /**
   * One candidate output at `conf` confirmations whose block cannot be timed.
   * `blockTimeMs` gives a test its own block: the same height and time would
   * be the same hash, which the process-lifetime hash → time cache may
   * already hold from another test's recovery leg.
   */
  function brokenCandidate(txid: string, conf: number, blockTimeMs = T0): void {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    chain.tip = 2_000;
    const b = confirm(txid, chain.tip - conf + 1, blockTimeMs);
    chain.broken.add(b.hash);
    setUtxos([{ txid, address: ADDR }]);
    vi.setSystemTime(T0 + MS_PER_DAY);
  }

  it("at 5 confirmations: no alert, the output not credited, the warning fires", async () => {
    brokenCandidate("c5".repeat(32), 5);
    await scanSubscriptionDeposits();
    expect(ledgerRows("c5".repeat(32))).toBe(0);
    expect(await uncreditedAlerts()).toEqual([]);
    expect(warnsNaming(`${"c5".repeat(32)}:0`)).toBe(1);
  });

  it("at 6 confirmations: exactly one warning-severity alert with §4.4's heading, message and data", async () => {
    const tx = "c6".repeat(32);
    brokenCandidate(tx, 6);
    await scanSubscriptionDeposits();
    expect(ledgerRows(tx)).toBe(0);
    expect(warnsNaming(`${tx}:0`)).toBe(1);

    const alerts = await uncreditedAlerts();
    expect(alerts).toHaveLength(1);
    const [a] = alerts;
    expect(a.severity).toBe("warning");
    expect(a.heading).toBe(HEADING);
    expect(a.message).toBe(
      "1 confirmed subscription payment(s) at member deposit addresses are not credited yet. " +
        "The oldest has 6 confirmations. Each scan retries them; this alert's data names each one and why it is waiting.",
    );
    expect(a.data.count).toBe(1);
    expect(a.data.oldest_confirmations).toBe(6);
    expect(a.data.warning_at_confirmations).toBe(6);
    expect(a.data.critical_at_confirmations).toBe(144);
    expect(a.data.outputs).toEqual([
      expect.objectContaining({
        outpoint: `${tx}:0`,
        member: MEMBER.slice(0, 16),
        confirmations: 6,
        cause: "time_unavailable",
        held_behind: null,
      }),
    ]);
    expect(typeof a.data.outputs[0].detail).toBe("string");
  });

  it("at 144 confirmations: exactly one critical alert; recovery credits and clears", async () => {
    const tx = "cf".repeat(32);
    brokenCandidate(tx, 144);
    await scanSubscriptionDeposits();
    expect(ledgerRows(tx)).toBe(0);
    expect(warnsNaming(`${tx}:0`)).toBe(1);
    const alerts = await uncreditedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");

    // Recovery.
    chain.broken.clear();
    await scanSubscriptionDeposits();
    expect(ledgerRows(tx)).toBe(1);
    expect(await uncreditedAlerts()).toEqual([]);
  });

  it("restart at 144: after a fresh import, no alert before the first scan, one critical after it; the warning stays", async () => {
    // Its own test, so a mutation that drops the alert trips HERE, on the
    // restart leg's own assertion, not on an earlier leg's. Nothing below
    // asserts the alert before the restart.
    const tx = "ce".repeat(32);
    brokenCandidate(tx, 144, T0 + 60_000);
    await scanSubscriptionDeposits(); // the pre-restart scan
    expect(ledgerRows(tx)).toBe(0);
    expect(warnsNaming(`${tx}:0`)).toBe(1);

    // Restart: a fresh module import over the same DB_DIR.
    closeDb();
    await reopen();
    expect(await uncreditedAlerts()).toEqual([]); // the snapshot starts empty
    await scanSubscriptionDeposits(); // the boot scan
    const alerts = await uncreditedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].data.oldest_confirmations).toBe(144); // the wait did not reset
    expect(ledgerRows(tx)).toBe(0);
    expect(warnsNaming(`${tx}:0`)).toBe(2); // the restart reset the throttle; the warning stays
  });
});

describe("§9 (viii-b) — the alert is cause-agnostic: a credit that throws", () => {
  /** Two timed outputs for one member, A at h and B at h+2; A's credit throws. */
  function throwingPair(confA: number): { txA: string; txB: string } {
    const txA = "d" + String(confA).padStart(3, "0") + "a".repeat(60);
    const txB = "d" + String(confA).padStart(3, "0") + "b".repeat(60);
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    chain.tip = 2_000;
    const hA = chain.tip - confA + 1;
    confirm(txA, hA, T0);
    confirm(txB, hA + 2, T0 + 20 * 60 * 1000);
    setUtxos([
      { txid: txB, address: ADDR },
      { txid: txA, address: ADDR },
    ]);
    // Between the time lookup and the credit, the member row vanishes, so
    // detector.ts's "Member row vanished mid-scan" fires on A.
    chain.onLookup = () => db.prepare("DELETE FROM subscription WHERE member_pubkey = ?").run(MEMBER);
    vi.setSystemTime(T0 + MS_PER_DAY);
    return { txA, txB };
  }

  it("A at 5: no alert, neither output credited", async () => {
    const { txA, txB } = throwingPair(5);
    await scanSubscriptionDeposits();
    expect(ledgerRows(txA)).toBe(0);
    expect(ledgerRows(txB)).toBe(0);
    expect(await uncreditedAlerts()).toEqual([]);
  });

  it("A at 6: one warning, count 2, A credit_threw with the error, B held_behind A; the throw is logged", async () => {
    const { txA, txB } = throwingPair(6);
    await scanSubscriptionDeposits();
    expect(ledgerRows(txA)).toBe(0);
    expect(ledgerRows(txB)).toBe(0);
    expect(warnsNaming(`${txA}:0`)).toBe(1);
    expect(warnsNaming("Member row vanished mid-scan")).toBe(1);

    const alerts = await uncreditedAlerts();
    expect(alerts).toHaveLength(1);
    const [a] = alerts;
    expect(a.severity).toBe("warning");
    expect(a.data.count).toBe(2);
    expect(a.data.oldest_confirmations).toBe(6);
    const byOutpoint = new Map(a.data.outputs.map((o: any) => [o.outpoint, o]));
    expect(byOutpoint.get(`${txA}:0`)).toMatchObject({ cause: "credit_threw", held_behind: null, confirmations: 6 });
    expect((byOutpoint.get(`${txA}:0`) as any).detail).toContain("Member row vanished mid-scan");
    expect(byOutpoint.get(`${txB}:0`)).toMatchObject({ cause: "held_behind", held_behind: `${txA}:0`, confirmations: 4 });
    expect(a.data.outputs.map((o: any) => o.confirmations)).toEqual([6, 4]);
  });

  it("A at 144: one critical; recovery credits both and clears the alert", async () => {
    const { txA, txB } = throwingPair(144);
    await scanSubscriptionDeposits();
    expect(ledgerRows(txA)).toBe(0);
    expect(ledgerRows(txB)).toBe(0);
    const alerts = await uncreditedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");

    // Recovery: stop the throw (the row is back, nothing deletes it).
    chain.onLookup = null;
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    await scanSubscriptionDeposits();
    expect(ledgerRows(txA)).toBe(1);
    expect(ledgerRows(txB)).toBe(1);
    expect(await uncreditedAlerts()).toEqual([]);
  });

  it("the gate: first run NOT acknowledged, a deposit output at 144 in neither table → no alert, no ledger row", async () => {
    db.prepare("UPDATE subscription_policy SET first_run_acknowledged_at = NULL WHERE id = 1").run();
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    chain.tip = 2_000;
    const tx = "e1".repeat(32);
    confirm(tx, chain.tip - 144 + 1, T0);
    setUtxos([{ txid: tx, address: ADDR }]);
    vi.setSystemTime(T0 + MS_PER_DAY);
    closeDb();
    await reopen(); // a fresh process: no snapshot carried over

    await scanSubscriptionDeposits();
    expect(ledgerRows(tx)).toBe(0);
    expect(await uncreditedAlerts()).toEqual([]);
  });
});

describe("addendum controls (x), (xi) — the relayed rulings (2026-11-13)", () => {
  it("(x) in-flight guard: a scan started while the first's time lookup is pending makes no lookup and no write", async () => {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY); // lapsed at T_conf
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    vi.setSystemTime(T0 + MS_PER_HOUR);

    let release!: () => void;
    chain.lookupGate = new Promise<void>((r) => (release = r));
    const firstP = scanSubscriptionDeposits();
    // Let the first scan run up to its held lookup (bounded: no hang if it
    // never gets there — that is then the failure, read off lookupCalls).
    for (let i = 0; i < 50 && chain.lookupCalls === 0; i++) await new Promise((r) => setImmediate(r));
    expect(chain.lookupCalls, "the first scan never reached a confirmation-time lookup").toBe(1);

    const secondP = scanSubscriptionDeposits();
    const second = await Promise.race([
      secondP,
      new Promise<"second-scan-still-pending">((r) => setTimeout(() => r("second-scan-still-pending"), 500)),
    ]);
    // Read the state while the first scan is still held, then release before
    // asserting, so a failure never leaves either scan dangling.
    const lookupsWhileHeld = chain.lookupCalls;
    const rowsWhileHeld = ledgerRows(TXA);
    release();
    const first = await firstP;
    await secondP;

    expect(lookupsWhileHeld, "the second scan made a confirmation-time lookup").toBe(1);
    expect(rowsWhileHeld, "a write happened while the first scan was held").toBe(0);
    expect(second).not.toBe("second-scan-still-pending");
    expect((second as any).skipped_reason).toBe("scan_in_flight");

    expect(first.skipped_reason).toBeUndefined();
    expect(chain.lookupCalls).toBe(1);
    expect(ledgerRows(TXA)).toBe(1);
    expect(paidThroughOf(MEMBER)).toBe(T0 + 30 * MS_PER_DAY); // T_conf + days
  });

  it("(xi) a credit that throws: one warning naming the outpoint and the error; later outputs held; no new warning inside the throttle window", async () => {
    const D0 = T0;
    seedMember(MEMBER, ADDR, D0 - MS_PER_DAY);
    confirm(TXA, 1_000, D0);
    confirm(TXB, 1_002, D0 + 20 * 60 * 1000);
    chain.tip = 1_010;
    setUtxos([
      { txid: TXB, address: ADDR },
      { txid: TXA, address: ADDR },
    ]);
    // A forced error in the write, on the detector's own connection.
    db.exec(
      `CREATE TEMP TRIGGER force_write_error BEFORE INSERT ON subscription_payment
       WHEN NEW.txid = '${TXA}' BEGIN SELECT RAISE(ABORT, 'forced write error (test)'); END`,
    );
    vi.setSystemTime(D0 + MS_PER_HOUR);

    await scanSubscriptionDeposits();
    expect(warnsNaming(`${TXA}:0`)).toBe(1);
    expect(
      warnSpy.mock.calls.filter((args) => {
        const line = args.map(String).join(" ");
        return line.includes(`${TXA}:0`) && line.includes("forced write error (test)");
      }).length,
    ).toBe(1);
    expect(ledgerRows(TXA)).toBe(0);
    expect(ledgerRows(TXB)).toBe(0); // the member's later output is held

    vi.setSystemTime(D0 + MS_PER_HOUR + 10 * 60 * 1000); // a later tick, inside the hour
    await scanSubscriptionDeposits();
    expect(warnsNaming(`${TXA}:0`)).toBe(1); // throttled: no new warning
    expect(ledgerRows(TXA)).toBe(0);
    expect(ledgerRows(TXB)).toBe(0);
  });
});

describe("lookup-before-write (relayed ruling, 2026-11-13)", () => {
  it("every confirmation-time lookup of a tick completes before any write", async () => {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    seedMember(MEMBER2, ADDR2, T0 - MS_PER_DAY);
    // Blocks no other case uses: the process-lifetime hash → time cache would
    // answer an already-timed block without a header call.
    confirm(TXA, 1_500, T0 + 7_000);
    confirm(TXB, 1_501, T0 + 10 * 60 * 1000 + 7_000);
    chain.tip = 1_505;
    setUtxos([
      { txid: TXA, address: ADDR },
      { txid: TXB, address: ADDR2 },
    ]);
    chain.countRows = () =>
      (db.prepare("SELECT COUNT(*) c FROM subscription_payment").get() as { c: number }).c;
    vi.setSystemTime(T0 + MS_PER_HOUR);

    await scanSubscriptionDeposits();
    expect(ledgerRows(TXA)).toBe(1);
    expect(ledgerRows(TXB)).toBe(1);
    expect(chain.rowsAtHeaderCall).toEqual([0, 0]);
  });
});

describe("what is stored (O4 (c) with (c1))", () => {
  it("confirmed_at = T_conf, received_at = detection time, last_payment_at = T_conf (never moved backwards)", async () => {
    seedMember(MEMBER, ADDR, T0 - MS_PER_DAY);
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR }]);
    const detected = T0 + 3 * MS_PER_HOUR;
    vi.setSystemTime(detected);
    await scanSubscriptionDeposits();

    const row = db
      .prepare("SELECT received_at, confirmed_at FROM subscription_payment WHERE txid = ?")
      .get(TXA) as { received_at: number; confirmed_at: number };
    expect(row.confirmed_at).toBe(T0);
    expect(row.received_at).toBe(detected);
    const sub = db
      .prepare("SELECT last_payment_at, last_payment_txid FROM subscription WHERE member_pubkey = ?")
      .get(MEMBER) as { last_payment_at: number; last_payment_txid: string };
    expect(sub.last_payment_at).toBe(T0);
    expect(sub.last_payment_txid).toBe(TXA);

    // A later-detected payment confirmed EARLIER (the rescan residual, spec §5 (1))
    // does not move last_payment_at backwards.
    confirm(TXB, 990, T0 - 2 * MS_PER_HOUR);
    setUtxos([
      { txid: TXA, address: ADDR },
      { txid: TXB, address: ADDR },
    ]);
    await scanSubscriptionDeposits();
    const sub2 = db
      .prepare("SELECT last_payment_at, last_payment_txid FROM subscription WHERE member_pubkey = ?")
      .get(MEMBER) as { last_payment_at: number; last_payment_txid: string };
    expect(sub2.last_payment_at).toBe(T0);
    expect(sub2.last_payment_txid).toBe(TXA);
  });

  it("the pending bucket gets the same treatment: confirmed_at = T_conf, received_at = detection", async () => {
    seedMember(MEMBER, ADDR, T0 + 10 * MS_PER_DAY);
    confirm(TXA, 1_000, T0);
    setUtxos([{ txid: TXA, address: ADDR, tokens: 1_000 }]);
    const detected = T0 + 2 * MS_PER_HOUR;
    vi.setSystemTime(detected);
    await scanSubscriptionDeposits();

    const row = db
      .prepare("SELECT received_at, confirmed_at FROM subscription_pending_attribution WHERE txid = ?")
      .get(TXA) as { received_at: number; confirmed_at: number };
    expect(row.confirmed_at).toBe(T0);
    expect(row.received_at).toBe(detected);
  });
});
