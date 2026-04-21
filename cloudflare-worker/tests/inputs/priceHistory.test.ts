import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_PRICE_HISTORY_KV_KEY, fetchBtcPriceHistory } from "../../src/valuation/inputs/priceHistory";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("fetchBtcPriceHistory", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses cached KV blob if fresh (< 12h old)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cached = [
      { timestamp: now - 86400, value: 70000 },
      { timestamp: now, value: 71000 },
    ];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({ fetched_at: now - 600, series: cached }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series).toEqual(cached);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches from CoinGecko when cache is missing", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        prices: [
          [1700000000000, 30000],
          [1700086400000, 30500],
        ],
      }), { status: 200 }),
    );
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series.length).toBe(2);
    expect(series[0].timestamp).toBe(1700000000); // ms → s
    expect(series[0].value).toBe(30000);
  });

  it("returns [] on upstream failure (no cache available)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series).toEqual([]);
  });

  it("refetches when cache is stale (> 12h old)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = { fetched_at: now - 86400, series: [{ timestamp: 100, value: 50000 }] };
    const kv = mockKV({ [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify(stale) });
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        prices: [[1700000000000, 30000]],
      }), { status: 200 }),
    );
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series[0].value).toBe(30000);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
