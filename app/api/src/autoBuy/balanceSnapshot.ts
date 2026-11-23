import type Database from "better-sqlite3";
import type { Balances } from "./exchangeProvider";

// The Kraken balance snapshot and the funds coverage both the low-funds
// warning and the "buys left" display read (kraken-autobuy P5; rulings S3, E3,
// G3, G11, Q1, D-P5-1..5).
//
// · WHAT IS STORED (Q1): buying power, i.e. the adapter's available balances
//   (balance + credit - credit_used - hold_trade). An asset Kraken does not
//   list reads 0, as the adapter reads it (D-P5-1); NULL is not written.
// · ONE BASIS (G11): fundsCoverage is the only place coverage is computed. The
//   warning (scheduler) and the display (GET /status) both call it, so they
//   cannot disagree.
// · USD ONLY (G3 + D-P4-8): on Kraken the next buy draws only from USD, so
//   only USD counts. USDC is stored and shown, never counted.
// · STALE (D-P5-5): older than an hour (four missed ticks) is stale. The
//   warning never fires from a stale snapshot; the display says it is old.

export const SNAPSHOT_STALE_SECONDS = 3600;
/** The warning fires when the balance covers fewer than this many next buys (E3). */
export const LOW_FUNDS_BUYS = 2;

export interface BalanceSnapshot {
  usd_available: number;
  usdc_available: number;
  btc_available: number;
  read_at: number;
}

/** The next buy's amount: the scheduler's own rule (base × multiplier, to the cent). */
export function intendedBuyUsd(baseUnitUsd: number, multiplier: number): number {
  return Math.round(baseUnitUsd * multiplier * 100) / 100;
}

export function writeKrakenSnapshot(db: Database.Database, b: Balances, readAt: number): void {
  db.prepare(
    `INSERT INTO autobuy_balance_snapshot (provider, usd_available, usdc_available, btc_available, read_at)
     VALUES ('kraken', ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       usd_available = excluded.usd_available,
       usdc_available = excluded.usdc_available,
       btc_available = excluded.btc_available,
       read_at = excluded.read_at`,
  ).run(b.usd, b.usdc, b.btc ?? 0, readAt);
}

export function readKrakenSnapshot(db: Database.Database): BalanceSnapshot | null {
  const row = db.prepare(
    `SELECT usd_available, usdc_available, btc_available, read_at FROM autobuy_balance_snapshot WHERE provider = 'kraken'`,
  ).get() as { usd_available: number | null; usdc_available: number | null; btc_available: number | null; read_at: number } | undefined;
  if (!row) return null;
  return {
    usd_available: row.usd_available ?? 0,
    usdc_available: row.usdc_available ?? 0,
    btc_available: row.btc_available ?? 0,
    read_at: row.read_at,
  };
}

export function isStale(snapshot: BalanceSnapshot, nowSec: number): boolean {
  return nowSec - snapshot.read_at > SNAPSHOT_STALE_SECONDS;
}

export interface FundsCoverage {
  currency: "USD";
  usd_available: number;
  next_buy_usd: number;
  multiplier: number;
  /** floor(usd_available / next_buy_usd); null when the current zone buys nothing (multiplier 0). */
  buys_covered: number | null;
  read_at: number;
  stale: boolean;
}

/** Coverage of the next buys by the snapshot's USD, at the current multiplier. Null without a snapshot. */
export function fundsCoverage(
  snapshot: BalanceSnapshot | null,
  baseUnitUsd: number,
  multiplier: number,
  nowSec: number,
): FundsCoverage | null {
  if (!snapshot) return null;
  const next = intendedBuyUsd(baseUnitUsd, multiplier);
  const usd = snapshot.usd_available;
  return {
    currency: "USD",
    usd_available: usd,
    next_buy_usd: next,
    multiplier,
    buys_covered: next > 0 ? Math.floor(usd / next) : null,
    read_at: snapshot.read_at,
    stale: isStale(snapshot, nowSec),
  };
}

/** The E3 trigger: a fresh snapshot covering fewer than two next buys. Stale, missing or zero-zone: never. */
export function isLowFunds(c: FundsCoverage | null): boolean {
  return c !== null && !c.stale && c.buys_covered !== null && c.buys_covered < LOW_FUNDS_BUYS;
}
