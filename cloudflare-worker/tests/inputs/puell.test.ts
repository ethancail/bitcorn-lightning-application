import { describe, expect, it } from "vitest";
import { puell } from "../../src/valuation/inputs/puell";
import { MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("puell adapter", () => {
  it("has key 'puell' and source 'manual'", () => {
    expect(puell.key).toBe("puell");
    expect(puell.source).toBe("manual");
  });

  it("reads from manualStore", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        puell: [{ timestamp: 100, value: 2.1 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const r = await puell.fetchLatest(env);
    expect(r!.value).toBeCloseTo(2.1, 10);
  });
});
