// Daybreak DRAFT INTAKE (spec §3.4.1): the one place a Z enters an edition.
//
// For an EXPLICITLY STATED edition date (Ruling E — never a clock):
//   load params (fail closed) → fetch both closes → check staleness →
//   compute Z (powerLawZ.ts) → stamp the Worker-owned fields → writeDraft.
//
// ─── THE RESERVED KEY ────────────────────────────────────────────────────
//
// Everything the Worker owns lives under ONE top-level key, WORKER_OWNED_KEY.
// Whatever the drafting agent put under it is DISCARDED and replaced (H.2: a
// payload-supplied Z is overwritten, never trusted). Every other top-level key
// is the agent's written sections, carried through untouched; their schema is
// not this module's.
//
// ─── FAILURE: THE DRAFT IS STILL WRITTEN (I.2) ───────────────────────────
//
// Absent or invalid params, a failed fetch, a stale close or an invalid
// computation each produce a Z block with status "unavailable", a reason and a
// detail — and NO number. The written sections are kept and the draft is
// written. Only an invalid date or non-object content rejects the intake,
// because then there is no edition to write (Ruling E; store.ts).
//
// ─── STALENESS IS MEASURED FROM THE EDITION'S DATE (J.1) ─────────────────
//
// A close's age is the calendar days between its date and the edition date the
// draft is FOR — never the date intake happens to run. Corn ≤ 4, Bitcoin ≤ 2
// (I.3); one day past either bound fails closed.
//
// ─── THE OBSERVATION DATE ────────────────────────────────────────────────
//
// The trend's age is taken at the LATER of the two close dates — RULED
// 2026-09-24 (spec §3.4.1; decisions/2026-09-24-daybreak-future-dated-close-
// rejected-trend-at-later-close.md), accepted as built. It matches the model
// author's workbook, whose rows are calendar dates carrying that day's BTC
// close and the most recent corn close (weekend corn is Friday's, carried).
//
// ─── A CLOSE DATED AFTER ITS EDITION IS REJECTED ─────────────────────────
//
// Same ruling: a close dated after the edition's Central date makes the Z
// unavailable with reason "future_dated_close". A close dated ON the edition's
// date (age 0) is allowed.

import type { CloseFetcher, CloseFetchResult, PriceSymbol } from "./closes";
import { isCentralDate, type CentralDate } from "./dates";
import { writeDraft, type DaybreakStoreError, type EditionContent } from "./store";
import { loadPowerLawParams } from "../valuation/powerLawParams";
import { computePowerLawZ } from "../valuation/powerLawZ";

export const WORKER_OWNED_KEY = "workerOwned";

export const CORN_SYMBOL: PriceSymbol = "ZC=F";
export const BTC_SYMBOL: PriceSymbol = "BTC-USD";

/** Calendar days from a close's date to the edition's date (I.3, J.1). */
export const STALENESS_BOUND_DAYS: Readonly<Record<PriceSymbol, number>> = { "ZC=F": 4, "BTC-USD": 2 };

export interface StampedClose {
  date: CentralDate;
  close: number;
  fetchedAt: string;
}

export type ZUnavailableReason =
  | "params_unavailable"
  | "fetch_failed"
  | "future_dated_close"
  | "stale_close"
  | "computation_failed";

export type ZBlock =
  | { status: "available"; value: number; corn: StampedClose; btc: StampedClose }
  | { status: "unavailable"; reason: ZUnavailableReason; detail: string };

export interface WorkerOwned {
  z: ZBlock;
}

export type IntakeResult = { ok: true; z: ZBlock["status"] } | DaybreakStoreError;

export interface IntakeDeps {
  kv: KVNamespace;
  fetcher: CloseFetcher;
}

const MS_PER_DAY = 86_400_000;

function isPlainObject(v: unknown): v is EditionContent {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function daysBetween(from: CentralDate, to: CentralDate): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;
}

function unavailable(reason: ZUnavailableReason, detail: string): ZBlock {
  return { status: "unavailable", reason, detail };
}

async function fetchClose(fetcher: CloseFetcher, symbol: PriceSymbol): Promise<CloseFetchResult> {
  try {
    return await fetcher.latestCompletedClose(symbol);
  } catch (err) {
    return { ok: false, symbol, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function computeZBlock({ kv, fetcher }: IntakeDeps, editionDate: CentralDate): Promise<ZBlock> {
  const params = await loadPowerLawParams(kv);
  if (!params.ok) return unavailable("params_unavailable", `${params.reason}: ${params.detail}`);

  const closes = await Promise.all([fetchClose(fetcher, CORN_SYMBOL), fetchClose(fetcher, BTC_SYMBOL)]);
  const failed = closes.flatMap((c) => (c.ok ? [] : [`${c.symbol}: ${c.reason}: ${c.detail}`]));
  if (failed.length > 0) return unavailable("fetch_failed", failed.join("; "));
  const [corn, btc] = closes as Extract<CloseFetchResult, { ok: true }>[];

  const future: string[] = [];
  const stale: string[] = [];
  for (const c of [corn, btc]) {
    const age = isCentralDate(c.date) ? daysBetween(c.date, editionDate) : NaN;
    const bound = STALENESS_BOUND_DAYS[c.symbol];
    // The ONLY accepting branch needs both comparisons true, so an unreadable
    // date (NaN fails every comparison) can pass neither route. It falls
    // through to stale below, as before.
    if (age >= 0 && age <= bound) continue;
    if (age < 0) {
      future.push(`${c.symbol} close dated ${c.date} is ${-age} days after the ${editionDate} edition`);
    } else {
      stale.push(`${c.symbol} close dated ${String(c.date)} is ${age} days before the ${editionDate} edition; bound is ${bound}`);
    }
  }
  if (future.length > 0) return unavailable("future_dated_close", [...future, ...stale].join("; "));
  if (stale.length > 0) return unavailable("stale_close", stale.join("; "));

  const obsDate = corn.date > btc.date ? corn.date : btc.date;
  const z = computePowerLawZ({ date: obsDate, corn: corn.close, btc: btc.close }, params.params);
  if (!z.ok) return unavailable("computation_failed", `${z.error}: ${z.detail}`);

  const stamp = (c: typeof corn): StampedClose => ({ date: c.date, close: c.close, fetchedAt: c.fetchedAt });
  return { status: "available", value: z.value.z, corn: stamp(corn), btc: stamp(btc) };
}

/** The drafting agent's intake: stamp the Worker-owned fields, then writeDraft. */
export async function runDraftIntake(deps: IntakeDeps, editionDate: CentralDate, content: EditionContent): Promise<IntakeResult> {
  if (!isCentralDate(editionDate)) {
    return { ok: false, reason: "invalid_date", detail: `an explicit YYYY-MM-DD Central edition date is required, got ${String(editionDate)}` };
  }
  if (!isPlainObject(content)) {
    return { ok: false, reason: "invalid_content", detail: "edition content must be a plain JSON object" };
  }

  const z = await computeZBlock(deps, editionDate);
  const { [WORKER_OWNED_KEY]: _discarded, ...sections } = content;
  const owned: WorkerOwned = { z };
  const written = await writeDraft(deps.kv, editionDate, { ...sections, [WORKER_OWNED_KEY]: owned });
  if (!written.ok) return written;
  return { ok: true, z: z.status };
}
