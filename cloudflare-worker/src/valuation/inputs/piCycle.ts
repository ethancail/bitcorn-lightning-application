import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchBtcPriceHistory } from "./priceHistory";

const SMA_FAST = 111;
const SMA_SLOW = 350;

// PI Cycle Top Indicator: ratio of (111-day SMA × 2) / (350-day SMA).
// Historically, values approaching 1.0 from above have marked cycle tops.
// A raw ratio rather than a boolean flag so the Z-score composite can
// express the distance-to-top as a continuous signal.
export const piCycle: InputAdapter = {
  key: "pi_cycle",
  label: "PI Cycle Top Indicator",
  category: "market",
  source: "derived",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await computeSeries(env);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return computeSeries(env);
  },
};

async function computeSeries(env: Env): Promise<InputReading[]> {
  const prices = await fetchBtcPriceHistory(env);
  if (prices.length < SMA_SLOW) return [];

  const out: InputReading[] = [];
  let fastSum = 0;
  let slowSum = 0;

  // Seed both sums
  for (let i = 0; i < SMA_SLOW; i++) {
    slowSum += prices[i].value;
    if (i >= SMA_SLOW - SMA_FAST) fastSum += prices[i].value;
  }

  // First output at index SMA_SLOW - 1
  out.push({
    timestamp: prices[SMA_SLOW - 1].timestamp,
    value: ((fastSum / SMA_FAST) * 2) / (slowSum / SMA_SLOW),
  });

  for (let i = SMA_SLOW; i < prices.length; i++) {
    fastSum += prices[i].value - prices[i - SMA_FAST].value;
    slowSum += prices[i].value - prices[i - SMA_SLOW].value;
    out.push({
      timestamp: prices[i].timestamp,
      value: ((fastSum / SMA_FAST) * 2) / (slowSum / SMA_SLOW),
    });
  }

  return out;
}
