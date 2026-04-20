import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchBtcPriceHistory } from "./priceHistory";

const WINDOW_DAYS = 200 * 7; // 1400

// 200-Week Moving Average Heatmap metric: percentage deviation of the daily
// BTC close price from its 200-week (1400-day) simple moving average.
// Value formula per day: (price - MA) / MA. Positive = price above 200W MA.
export const ma200w: InputAdapter = {
  key: "ma_200w",
  label: "200-Week MA Heatmap",
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
  if (prices.length < WINDOW_DAYS) return [];

  const out: InputReading[] = [];
  let runningSum = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) runningSum += prices[i].value;

  // First output point is at index WINDOW_DAYS - 1
  const firstMa = runningSum / WINDOW_DAYS;
  out.push({
    timestamp: prices[WINDOW_DAYS - 1].timestamp,
    value: (prices[WINDOW_DAYS - 1].value - firstMa) / firstMa,
  });

  for (let i = WINDOW_DAYS; i < prices.length; i++) {
    runningSum += prices[i].value - prices[i - WINDOW_DAYS].value;
    const ma = runningSum / WINDOW_DAYS;
    out.push({
      timestamp: prices[i].timestamp,
      value: (prices[i].value - ma) / ma,
    });
  }

  return out;
}
