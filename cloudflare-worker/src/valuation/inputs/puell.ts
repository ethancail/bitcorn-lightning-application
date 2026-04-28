import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { loadManualHistory } from "../manualStore";
import { fetchCoinMetricsSeries } from "./coinMetrics";

// Puell Multiple — daily miner issuance in USD divided by its 365-day MA.
// Traditional definition uses block subsidy only (excludes transaction fees).
//
//   < 0.5  → miner capitulation territory (historical buy zone)
//   > 4.0  → cycle-top miner profitability (historical sell zone)
//
// Engine then Z-scores the full Puell history.
//
// Three free upstreams compose the signal — no single API exposes Puell free:
//   1. Mempool.space: difficulty adjustments (height + time pairs) and daily
//      hashrate timestamps. Used to compute blocks-per-day during each
//      adjustment epoch (= 2016 / days_between_adjustments).
//   2. CoinMetrics PriceUSD: daily BTC price, ~5,763 entries since 2010.
//   3. Deterministic halving schedule: subsidy = 50 / 2^(height / 210000).
//
// Daily issuance USD = blocks_per_day × subsidy(height) × BTC_price_USD.
// The 365-day trailing ratio is what the engine sees.
//
// Falls back to operator-entered manual values if either upstream fails or
// produces fewer than 365 + warmup days of usable readings.
const MEMPOOL_ENDPOINT = "https://mempool.space/api/v1/mining/hashrate/all";
const PUELL_WINDOW = 365;
const TARGET_BLOCKS_PER_DAY = 144;

interface MempoolMiningResponse {
  hashrates?: Array<{ timestamp?: number }>;
  difficulty?: Array<{ time?: number; height?: number; difficulty?: number }>;
}

function subsidyAtHeight(height: number): number {
  // Pre-genesis or invalid heights → 0 (filtered out downstream).
  if (!Number.isFinite(height) || height < 0) return 0;
  return 50 / Math.pow(2, Math.floor(height / 210000));
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

async function fetchMempoolMining(): Promise<MempoolMiningResponse | null> {
  try {
    const res = await fetch(MEMPOOL_ENDPOINT, {
      headers: { "User-Agent": "bitcorn-lightning/valuation" },
    });
    if (!res.ok) {
      console.error(`[puell] mempool HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as MempoolMiningResponse;
  } catch (err) {
    console.error(
      "[puell] mempool fetch error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function fetchHistory(env: Env): Promise<InputReading[]> {
  const computed = await computePuell();
  if (computed.length > 0) return computed;

  const manual = await loadManualHistory(env.PRICES_CACHE);
  return manual.puell ?? [];
}

async function computePuell(): Promise<InputReading[]> {
  const [mining, prices] = await Promise.all([
    fetchMempoolMining(),
    fetchCoinMetricsSeries("PriceUSD", { logTag: "puell:price" }),
  ]);
  if (!mining || prices.length === 0) return [];

  const adjustments = (mining.difficulty ?? [])
    .filter(
      (d): d is { time: number; height: number; difficulty: number } =>
        typeof d.time === "number" &&
        typeof d.height === "number" &&
        typeof d.difficulty === "number" &&
        Number.isFinite(d.time) &&
        Number.isFinite(d.height) &&
        d.difficulty > 0,
    )
    .sort((a, b) => a.time - b.time);

  const hashrates = (mining.hashrates ?? [])
    .filter((h): h is { timestamp: number } =>
      typeof h.timestamp === "number" && Number.isFinite(h.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (adjustments.length === 0 || hashrates.length === 0) return [];

  const priceByDay = new Map<string, number>();
  for (const r of prices) priceByDay.set(isoDate(r.timestamp), r.value);

  // Walk daily timestamps; for each, derive the active difficulty epoch's
  // blocks-per-day rate, the subsidy at that height, and the day's BTC price.
  const dailyIssuanceUsd: InputReading[] = [];
  let adjIdx = -1;
  for (const hr of hashrates) {
    while (
      adjIdx + 1 < adjustments.length &&
      adjustments[adjIdx + 1].time <= hr.timestamp
    ) {
      adjIdx += 1;
    }
    if (adjIdx < 0) continue; // pre-first-adjustment, skip

    const adj = adjustments[adjIdx];
    const next = adjustments[adjIdx + 1];
    let blocksPerDay = TARGET_BLOCKS_PER_DAY;
    if (next) {
      const days = (next.time - adj.time) / 86400;
      if (days > 0) blocksPerDay = 2016 / days;
    }
    const subsidy = subsidyAtHeight(adj.height);
    if (subsidy <= 0) continue;

    const price = priceByDay.get(isoDate(hr.timestamp));
    if (!price || !Number.isFinite(price) || price <= 0) continue;

    dailyIssuanceUsd.push({
      timestamp: hr.timestamp,
      value: blocksPerDay * subsidy * price,
    });
  }

  if (dailyIssuanceUsd.length < PUELL_WINDOW) return [];

  // Trailing 365-day Puell = today's daily_issuance_usd / 365d MA of same.
  const out: InputReading[] = [];
  let runningSum = 0;
  for (let i = 0; i < PUELL_WINDOW; i++) runningSum += dailyIssuanceUsd[i].value;
  for (let i = PUELL_WINDOW - 1; i < dailyIssuanceUsd.length; i++) {
    if (i > PUELL_WINDOW - 1) {
      runningSum +=
        dailyIssuanceUsd[i].value - dailyIssuanceUsd[i - PUELL_WINDOW].value;
    }
    const ma = runningSum / PUELL_WINDOW;
    if (ma <= 0 || !Number.isFinite(ma)) continue;
    const ratio = dailyIssuanceUsd[i].value / ma;
    if (!Number.isFinite(ratio)) continue;
    out.push({ timestamp: dailyIssuanceUsd[i].timestamp, value: ratio });
  }
  return out;
}

export const puell: InputAdapter = {
  key: "puell",
  label: "Puell Multiple",
  category: "on-chain",
  source: "Mempool.space + CoinMetrics",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchHistory(env);
    return history.length === 0 ? null : history[history.length - 1];
  },

  fetchHistory,
};
