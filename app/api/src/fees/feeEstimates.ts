// fee-estimates — the one fee-estimate source for the three confirmation-speed
// cards (member Open Channel; treasury Close and New Channel).
//
// Spec: bitcorn-research specs/2026-11-16-fee-estimates-live-rates-and-times-spec.md
// §4 (O1, P5, P6, P10, P11, P22), §5 (O3, P7, P8, P9), §7 (P12), §8 (P14), §11 (O7).
//
// computeFeeEstimates is PURE: it takes what was read (the Worker's /fees answer,
// LND's curve at the fallback targets) and the clock, and returns the answer the
// route serves. readFeeEstimates does the reading.

import { ENV } from "../config/env";

export type OptionKey = "priority" | "normal" | "economy";
export const OPTION_KEYS: readonly OptionKey[] = ["priority", "normal", "economy"];

/** O5: the server refuses any fee_rate above this; P15: the cards block an option above it. */
export const FEE_RATE_CEILING_SAT_PER_VBYTE = 200;

/** P10: Worker data older than this is stale, and the LND curve is read instead. */
export const WORKER_STALE_AFTER_MS = 30 * 60 * 1000;

/** O3: the projected block per option (1-based; mempool.space index = block − 1). */
export const OPTION_BLOCK: Record<OptionKey, number> = { priority: 1, normal: 3, economy: 6 };

/** P5 (a): the LND confirmation target per option under the fallback. */
export const OPTION_LND_TARGET: Record<OptionKey, number> = { priority: 2, normal: 3, economy: 6 };

/** P12: rounded first-confirmation ranges (arithmetic on block intervals, not measured). */
export const OPTION_TIME_MINUTES: Record<OptionKey, { min: number; max: number }> = {
  priority: { min: 1, max: 25 },
  normal: { min: 10, max: 55 },
  economy: { min: 30, max: 95 },
};

/** P14 (b): estimated sizes, worded "about". */
export const SIZE_VB = { open: 155, close: 192 } as const;

/** O7: LND's silent fallback figure. The check may only REMOVE a number. */
const LND_FALLBACK_SIGNATURE = 25;

/**
 * P8, ruled final (F8, R1; D6): round up, except within 0.05 of an integer,
 * which rounds to that integer, with a minimum of 1. The minimum also lifts
 * Worker figures under 1. "Within" is read as inclusive.
 */
export function toSendableRate(satPerVbyte: number): number {
  const nearest = Math.round(satPerVbyte);
  const rounded =
    Math.abs(satPerVbyte - nearest) <= 0.05 + 1e-9 ? nearest : Math.ceil(satPerVbyte);
  return Math.max(1, rounded);
}

/** What the Worker's GET /fees answered, as read. null = not asked (not mainnet, P11). */
export type WorkerRead =
  | { ok: true; header: string | null; body: unknown }
  | { ok: false; header: string | null; error: string };

/** LND's curve at the three fallback targets, as read. null = not read. */
export type LndRead = Record<number, { ok: true; satPerVbyte: number } | { ok: false; error: string }>;

export interface FeeOption {
  key: OptionKey;
  rate: number;
  /** The projected block (Worker) the rate came from; null under the fallback. */
  block: number | null;
  /** The LND confirmation target (fallback) the rate came from; null with Worker data. */
  target: number | null;
  time_minutes: { min: number; max: number };
  /** O1: true under the LND fallback — shown as "estimate", never as a precise time. */
  estimate: boolean;
  cost_sats: { open: number; close: number };
}

export interface FeeEstimates {
  source: "worker" | "lnd" | "unavailable";
  /** The Worker's X-Fee-Source header when the Worker was asked, else null. */
  worker_source: string | null;
  /** When the data behind the rates was fetched (Worker fetched_at, or the LND read time). */
  data_fetched_at: string | null;
  data_age_seconds: number | null;
  /** Why the answer is unavailable (O7, P6); null otherwise. */
  unavailable_reason: "lnd_flat_25" | "lnd_error" | null;
  ceiling_sat_per_vbyte: number;
  sizes_vb: typeof SIZE_VB;
  options: Record<OptionKey, FeeOption> | null;
}

/**
 * D5: valid if an array (possibly empty) in which every block used has a
 * finite positive medianFee. feeRange is never read.
 */
export function usedBlockMedians(blocks: unknown): number[] | null {
  if (!Array.isArray(blocks)) return null;
  if (blocks.length === 0) return [];
  const medians: number[] = [];
  for (const key of OPTION_KEYS) {
    // P9 (a): an absent projected block takes the last present block's figure.
    const block = blocks[Math.min(OPTION_BLOCK[key] - 1, blocks.length - 1)];
    const median = typeof block === "object" && block !== null ? (block as any).medianFee : undefined;
    if (typeof median !== "number" || !Number.isFinite(median) || median <= 0) return null;
    medians.push(median);
  }
  return medians;
}

/** The Worker's data, if valid and no older than P10; else null. */
function usableWorkerData(
  worker: WorkerRead | null,
  nowMs: number,
): { medians: number[]; fetchedAtMs: number } | null {
  if (!worker || !worker.ok) return null;
  const body = worker.body as { fetched_at?: unknown; blocks?: unknown } | null;
  if (typeof body !== "object" || body === null) return null;
  if (typeof body.fetched_at !== "string") return null;
  const fetchedAtMs = Date.parse(body.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) return null;
  if (nowMs - fetchedAtMs > WORKER_STALE_AFTER_MS) return null;
  const medians = usedBlockMedians(body.blocks);
  if (medians === null) return null;
  return { medians, fetchedAtMs };
}

/** True when the Worker's answer can be used, so LND need not be read. */
export function workerIsUsable(worker: WorkerRead | null, nowMs: number): boolean {
  return usableWorkerData(worker, nowMs) !== null;
}

function option(key: OptionKey, rate: number, fromWorker: boolean): FeeOption {
  return {
    key,
    rate,
    block: fromWorker ? OPTION_BLOCK[key] : null,
    target: fromWorker ? null : OPTION_LND_TARGET[key],
    time_minutes: OPTION_TIME_MINUTES[key],
    estimate: !fromWorker,
    cost_sats: { open: rate * SIZE_VB.open, close: rate * SIZE_VB.close },
  };
}

export function computeFeeEstimates(input: {
  nowMs: number;
  worker: WorkerRead | null;
  lnd: LndRead | null;
}): FeeEstimates {
  const { nowMs, worker, lnd } = input;
  const base = {
    worker_source: worker ? worker.header : null,
    ceiling_sat_per_vbyte: FEE_RATE_CEILING_SAT_PER_VBYTE,
    sizes_vb: SIZE_VB,
  };

  // 1. Worker data, valid and no older than P10.
  const w = usableWorkerData(worker, nowMs);
  if (w) {
    const options = {} as Record<OptionKey, FeeOption>;
    OPTION_KEYS.forEach((key, i) => {
      // P9 at zero blocks (F7): every option takes P8's minimum.
      const rate = w.medians.length === 0 ? toSendableRate(0) : toSendableRate(w.medians[i]);
      options[key] = option(key, rate, true);
    });
    return {
      ...base,
      source: "worker",
      data_fetched_at: new Date(w.fetchedAtMs).toISOString(),
      data_age_seconds: Math.floor((nowMs - w.fetchedAtMs) / 1000),
      unavailable_reason: null,
      options,
    };
  }

  // 2. LND's curve at the fallback targets.
  const unavailable = (reason: "lnd_flat_25" | "lnd_error"): FeeEstimates => ({
    ...base,
    source: "unavailable",
    data_fetched_at: null,
    data_age_seconds: null,
    unavailable_reason: reason,
    options: null,
  });

  const reads = OPTION_KEYS.map((key) => lnd?.[OPTION_LND_TARGET[key]]);
  // P6 (a): any target erroring (or unread, or not a finite positive number) → unavailable.
  const figures: number[] = [];
  for (const r of reads) {
    if (!r || !r.ok || !Number.isFinite(r.satPerVbyte) || r.satPerVbyte <= 0) return unavailable("lnd_error");
    figures.push(r.satPerVbyte);
  }
  // O7: flat at exactly 25 across every target → no figure. Only removes a number.
  if (figures.every((f) => f === LND_FALLBACK_SIGNATURE)) return unavailable("lnd_flat_25");

  const options = {} as Record<OptionKey, FeeOption>;
  OPTION_KEYS.forEach((key, i) => {
    options[key] = option(key, toSendableRate(figures[i]), false);
  });
  return {
    ...base,
    source: "lnd",
    data_fetched_at: new Date(nowMs).toISOString(),
    data_age_seconds: 0,
    unavailable_reason: null,
    options,
  };
}

// ── The reading ─────────────────────────────────────────────────────────

/** How long the API waits for the Worker's /fees before treating it as failed. */
export const WORKER_FEES_TIMEOUT_MS = 5_000;

export async function readFeeEstimates(deps: {
  now?: () => number;
  network?: string;
  fetchWorkerFees: () => Promise<Response>;
  getChainFeeRate: (target: number) => Promise<{ tokens_per_vbyte: number }>;
}): Promise<FeeEstimates> {
  const now = deps.now ?? Date.now;
  const network = deps.network ?? ENV.bitcoinNetwork;

  // P11: mainnet only. Elsewhere the Worker is not asked.
  let worker: WorkerRead | null = null;
  if (network === "mainnet") {
    try {
      const res = await deps.fetchWorkerFees();
      const header = res.headers.get("x-fee-source");
      worker = res.ok
        ? { ok: true, header, body: await res.json() }
        : { ok: false, header, error: `http_${res.status}` };
    } catch (err: any) {
      worker = { ok: false, header: null, error: err?.message ?? String(err) };
    }
  }

  let lnd: LndRead | null = null;
  if (!workerIsUsable(worker, now())) {
    const targets = [...new Set(OPTION_KEYS.map((k) => OPTION_LND_TARGET[k]))];
    const settled = await Promise.allSettled(targets.map((t) => deps.getChainFeeRate(t)));
    lnd = {};
    targets.forEach((t, i) => {
      const s = settled[i];
      lnd![t] =
        s.status === "fulfilled"
          ? { ok: true, satPerVbyte: s.value.tokens_per_vbyte }
          : { ok: false, error: String((s.reason as any)?.message ?? s.reason) };
    });
  }

  return computeFeeEstimates({ nowMs: now(), worker, lnd });
}

