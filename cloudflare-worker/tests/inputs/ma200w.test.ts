import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ma200w } from "../../src/valuation/inputs/ma200w";
import { BTC_PRICE_HISTORY_KV_KEY } from "../../src/valuation/inputs/priceHistory";
import type { Env } from "../../src/lib/types";

const DAY = 86400;

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

// Build a 1500-day synthetic series with prices given by (day_index + 1) * 10.
// 200W = 1400 days, so the 200W-MA at day N (for N >= 1399) is the average of
// days (N-1399)..N. The adapter emits (price - MA) / MA at each eligible day.
function syntheticSeries(): Array<{ timestamp: number; value: number }> {
  const series = [];
  for (let i = 0; i < 1500; i++) {
    series.push({ timestamp: 1_700_000_000 + i * DAY, value: (i + 1) * 10 });
  }
  return series;
}

describe("ma200w adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'ma_200w' and source 'derived'", () => {
    expect(ma200w.key).toBe("ma_200w");
    expect(ma200w.source).toBe("derived");
  });

  it("returns empty history if price history has < 1400 days", async () => {
    const shortSeries = [{ timestamp: 100, value: 50 }];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series: shortSeries,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await ma200w.fetchHistory(env);
    expect(history).toEqual([]);
  });

  it("emits (price - MA) / MA for each day starting at index 1399", async () => {
    const series = syntheticSeries();
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await ma200w.fetchHistory(env);
    // 1500 days total - 1399 warm-up = 101 output points
    expect(history.length).toBe(101);
    // At day index 1399: MA = avg of days 0..1399 = mean((1..1400)*10) = 7005
    // Price = 14000; (14000 - 7005) / 7005 ≈ 0.9986
    expect(history[0].value).toBeCloseTo((14000 - 7005) / 7005, 4);
    expect(history[0].timestamp).toBe(series[1399].timestamp);
  });

  it("fetchLatest returns the last emitted point", async () => {
    const series = syntheticSeries();
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const reading = await ma200w.fetchLatest(env);
    expect(reading).not.toBeNull();
    // Day 1499: MA = avg of days 100..1499 = mean((101..1500)*10) = 8005
    // Price = 15000; (15000 - 8005) / 8005 ≈ 0.8739
    expect(reading!.value).toBeCloseTo((15000 - 8005) / 8005, 4);
  });
});
