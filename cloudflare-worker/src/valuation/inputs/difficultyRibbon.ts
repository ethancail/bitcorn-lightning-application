import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { loadManualHistory } from "../manualStore";

// Difficulty Ribbon — Willy Woo's miner-stress indicator. Computes 9 trailing
// MAs of network difficulty (9, 14, 25, 40, 60, 90, 128, 200, 360 days) and
// outputs their coefficient of variation (stdev / mean) per day.
//
//   low CoV  → MAs tightly clustered (compression) → end-of-bear / capitulation
//   high CoV → fast MA diverging from slow MAs    → expansion / mid-cycle
//
// Engine then Z-scores the full CoV history. A low-CoV reading produces a
// negative Z (undervalued / buy signal), matching the historical
// interpretation of compressed difficulty MAs as a miner-bottom marker.
//
// CoinMetrics gates `DiffLast` and `DiffMean` behind paid credentials, so we
// pull difficulty adjustments from Mempool.space (free, no key) and step-fill
// to daily — Bitcoin's difficulty changes only every 2016 blocks (~2 weeks),
// so there are ~26 adjustments per year that we extend to ~6,300 daily
// values via last-known-value carry-forward.
//
// Falls back to operator-entered manual values if the API fails or returns
// fewer than 360 days of usable data (the longest MA window).
const ENDPOINT = "https://mempool.space/api/v1/mining/hashrate/all";
const MA_WINDOWS = [9, 14, 25, 40, 60, 90, 128, 200, 360];
const LONGEST_WINDOW = MA_WINDOWS[MA_WINDOWS.length - 1];

interface MempoolHashrateResponse {
  hashrates?: Array<{ timestamp?: number }>;
  difficulty?: Array<{ time?: number; difficulty?: number }>;
}

async function fetchHistory(env: Env): Promise<InputReading[]> {
  const ribbon = await fetchFromMempool();
  if (ribbon.length > 0) return ribbon;

  const manual = await loadManualHistory(env.PRICES_CACHE);
  return manual.difficulty_ribbon ?? [];
}

async function fetchFromMempool(): Promise<InputReading[]> {
  let body: MempoolHashrateResponse;
  try {
    const res = await fetch(ENDPOINT, {
      headers: { "User-Agent": "bitcorn-lightning/valuation" },
    });
    if (!res.ok) {
      console.error(`[difficultyRibbon] HTTP ${res.status}`);
      return [];
    }
    body = (await res.json()) as MempoolHashrateResponse;
  } catch (err) {
    console.error(
      "[difficultyRibbon] fetch error:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const adjustments = (body.difficulty ?? [])
    .filter(
      (d): d is { time: number; difficulty: number } =>
        typeof d.time === "number" &&
        typeof d.difficulty === "number" &&
        Number.isFinite(d.time) &&
        Number.isFinite(d.difficulty) &&
        d.difficulty > 0,
    )
    .sort((a, b) => a.time - b.time);

  const hashrates = (body.hashrates ?? [])
    .filter((h): h is { timestamp: number } =>
      typeof h.timestamp === "number" && Number.isFinite(h.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (adjustments.length === 0 || hashrates.length < LONGEST_WINDOW) return [];

  // Step-fill daily difficulty: walk the daily timestamps in order, advancing
  // the adjustment cursor whenever the next adjustment's time is in the past.
  const daily: Array<{ ts: number; diff: number }> = [];
  let adjIdx = -1;
  for (const hr of hashrates) {
    while (
      adjIdx + 1 < adjustments.length &&
      adjustments[adjIdx + 1].time <= hr.timestamp
    ) {
      adjIdx += 1;
    }
    if (adjIdx < 0) continue; // pre-genesis daily entry, no difficulty yet
    daily.push({ ts: hr.timestamp, diff: adjustments[adjIdx].difficulty });
  }

  if (daily.length < LONGEST_WINDOW) return [];

  // Single-pass trailing MAs via running sums per window.
  const sums = new Array(MA_WINDOWS.length).fill(0);
  const out: InputReading[] = [];
  for (let i = 0; i < daily.length; i++) {
    for (let w = 0; w < MA_WINDOWS.length; w++) {
      sums[w] += daily[i].diff;
      if (i >= MA_WINDOWS[w]) sums[w] -= daily[i - MA_WINDOWS[w]].diff;
    }
    if (i < LONGEST_WINDOW - 1) continue;

    const mas = MA_WINDOWS.map((w, wi) => sums[wi] / w);
    const mean = mas.reduce((a, b) => a + b, 0) / mas.length;
    if (mean <= 0 || !Number.isFinite(mean)) continue;
    const variance =
      mas.reduce((a, b) => a + (b - mean) ** 2, 0) / mas.length;
    const cv = Math.sqrt(variance) / mean;
    if (!Number.isFinite(cv)) continue;
    out.push({ timestamp: daily[i].ts, value: cv });
  }

  return out;
}

export const difficultyRibbon: InputAdapter = {
  key: "difficulty_ribbon",
  label: "Difficulty Ribbon",
  category: "mining",
  source: "Mempool.space",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchHistory(env);
    return history.length === 0 ? null : history[history.length - 1];
  },

  fetchHistory,
};
