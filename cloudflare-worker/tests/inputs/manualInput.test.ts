import { describe, expect, it } from "vitest";
import { makeManualAdapter } from "../../src/valuation/inputs/manualInput";
import { MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("makeManualAdapter", () => {
  it("produces an adapter with correct key/label/category/source", () => {
    const a = makeManualAdapter({
      key: "mvrv",
      label: "MVRV Z-Score",
      category: "on-chain",
    });
    expect(a.key).toBe("mvrv");
    expect(a.label).toBe("MVRV Z-Score");
    expect(a.category).toBe("on-chain");
    expect(a.source).toBe("manual");
  });

  it("fetchHistory returns the series from the manual KV blob", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        mvrv: [{ timestamp: 100, value: 1 }, { timestamp: 200, value: 2 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "mvrv", label: "MVRV Z-Score", category: "on-chain" });
    const history = await a.fetchHistory(env);
    expect(history.length).toBe(2);
    expect(history[1].value).toBe(2);
  });

  it("fetchLatest returns the most recent reading", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        puell: [{ timestamp: 100, value: 0.4 }, { timestamp: 200, value: 0.45 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "puell", label: "Puell Multiple", category: "on-chain" });
    const reading = await a.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(0.45, 10);
  });

  it("fetchLatest returns null when no submissions yet", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "sopr", label: "SOPR (30d MA)", category: "on-chain" });
    expect(await a.fetchLatest(env)).toBeNull();
  });
});
