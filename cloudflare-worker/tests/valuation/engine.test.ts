import { describe, expect, it, vi } from "vitest";
import { runEngine, fetchSpotPrice } from "../../src/valuation/engine";
import * as persist from "../../src/valuation/persist";
import * as registry from "../../src/valuation/inputs";
import type { InputAdapter } from "../../src/valuation/inputs/types";
import type { Env } from "../../src/lib/types";

function fakeAdapter(key: keyof typeof import("../../src/valuation/composite").INPUT_WEIGHTS, values: number[]): InputAdapter {
  return {
    key,
    label: key,
    category: "market",
    source: "test",
    async fetchLatest() { return values.length ? { timestamp: Date.now()/1000, value: values[values.length-1] } : null; },
    async fetchHistory() {
      return values.map((v, i) => ({ timestamp: 1700000000 + i * 86400, value: v }));
    },
  };
}

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("runEngine", () => {
  it("computes a composite Z-score from adapter histories and writes 3 KV blobs", async () => {
    // Replace the registry with two small adapters
    const mockAdapters = [
      fakeAdapter("mvrv",  [1, 2, 3, 4, 5]),  // latest 5; mean=3; z=(5-3)/stdev
      fakeAdapter("puell", [5, 4, 3, 2, 1]),  // latest 1; mean=3; z=(1-3)/stdev
    ];
    vi.spyOn(registry, "ADAPTERS", "get").mockReturnValue(mockAdapters);

    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;

    await runEngine(env, { priceUsd: 71000, nowISO: "2026-04-17T00:15:00Z" });

    const cv = await persist.loadCurrent(kv);
    expect(cv).not.toBeNull();
    expect(cv!.price_usd).toBe(71000);
    expect(cv!.updated_at).toBe("2026-04-17T00:15:00Z");
    expect(Number.isFinite(cv!.z_score)).toBe(true);

    const inputs = await persist.loadInputs(kv);
    expect(Object.keys(inputs)).toEqual(["mvrv", "puell"]);

    const history = await persist.loadHistory(kv);
    expect(history.length).toBe(5);
  });

  it("skips adapters that return empty history", async () => {
    const mockAdapters = [
      fakeAdapter("mvrv", [1, 2, 3, 4, 5]),
      fakeAdapter("puell", []), // upstream down
    ];
    vi.spyOn(registry, "ADAPTERS", "get").mockReturnValue(mockAdapters);

    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;

    await runEngine(env, { priceUsd: 71000, nowISO: "2026-04-17T00:15:00Z" });
    const inputs = await persist.loadInputs(kv);
    expect(Object.keys(inputs)).toEqual(["mvrv"]);
  });
});

describe("fetchSpotPrice", () => {
  it("returns the current USD price from Coinbase Spot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { amount: "71434.42" } }), { status: 200 })
    );
    const price = await fetchSpotPrice();
    expect(price).toBeCloseTo(71434.42, 2);
    vi.restoreAllMocks();
  });

  it("returns 0 on upstream failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await fetchSpotPrice()).toBe(0);
    vi.restoreAllMocks();
  });
});
