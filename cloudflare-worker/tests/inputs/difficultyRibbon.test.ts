import { describe, expect, it } from "vitest";
import { difficultyRibbon } from "../../src/valuation/inputs/difficultyRibbon";
import { MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("difficultyRibbon adapter", () => {
  it("has key 'difficulty_ribbon' and source 'manual'", () => {
    expect(difficultyRibbon.key).toBe("difficulty_ribbon");
    expect(difficultyRibbon.source).toBe("manual");
  });

  it("reads from manualStore", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        difficulty_ribbon: [{ timestamp: 100, value: 2.1 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const r = await difficultyRibbon.fetchLatest(env);
    expect(r!.value).toBeCloseTo(2.1, 10);
  });
});
