import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piCycle } from "../../src/valuation/inputs/piCycle";
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

describe("piCycle adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'pi_cycle' and source 'derived'", () => {
    expect(piCycle.key).toBe("pi_cycle");
    expect(piCycle.source).toBe("derived");
  });

  it("returns empty history if price history has < 350 days", async () => {
    const short = [{ timestamp: 100, value: 50 }];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series: short,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    expect(await piCycle.fetchHistory(env)).toEqual([]);
  });

  it("emits (111 SMA * 2) / (350 SMA) for each eligible day", async () => {
    // Build a 400-day constant-price series at $10 each. Both MAs are 10,
    // so the ratio is (10 * 2) / 10 = 2 on every day.
    const series = Array.from({ length: 400 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * DAY,
      value: 10,
    }));
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await piCycle.fetchHistory(env);
    expect(history.length).toBe(51); // 400 - 349 warm-up = 51
    for (const r of history) {
      expect(r.value).toBeCloseTo(2, 10);
    }
  });
});
