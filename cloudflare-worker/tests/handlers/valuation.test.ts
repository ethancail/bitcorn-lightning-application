import { describe, expect, it } from "vitest";
import {
  handleValuationCurrent,
  handleValuationHistory,
  handleValuationInputs,
} from "../../src/handlers/valuation";
import { saveCurrent, saveHistory, saveInputs } from "../../src/valuation/persist";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("/valuation/current", () => {
  it("returns 404 when nothing persisted yet", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationCurrent(env);
    expect(res.status).toBe(404);
  });

  it("returns the stored blob with CORS + JSON headers", async () => {
    const kv = mockKV();
    await saveCurrent(kv, {
      z_score: -1.44, zone: "undervalued", multiplier: 2,
      updated_at: "2026-04-17T00:15:00Z", price_usd: 71434,
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await handleValuationCurrent(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json() as any;
    expect(body.z_score).toBeCloseTo(-1.44, 10);
    expect(body.zone).toBe("undervalued");
  });
});

describe("/valuation/history", () => {
  it("returns empty array when nothing persisted", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationHistory(env, new URL("https://w/valuation/history"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("applies since/until filters", async () => {
    const kv = mockKV();
    await saveHistory(kv, [
      { date: "2026-04-14", z_score: -1.2, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-15", z_score: -1.3, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-16", z_score: -1.4, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-17", z_score: -1.44, zone: "undervalued", price_usd: 0 },
    ]);
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const url = new URL("https://w/valuation/history?since=2026-04-15&until=2026-04-16");
    const res = await handleValuationHistory(env, url);
    const body = await res.json() as any;
    expect(body.series.map((r: any) => r.date)).toEqual(["2026-04-15", "2026-04-16"]);
  });
});

describe("/valuation/inputs", () => {
  it("returns {} when nothing persisted", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationInputs(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("returns the snapshot map", async () => {
    const kv = mockKV();
    await saveInputs(kv, {
      mvrv: { value: 2.1, z: -1.8, weight: 0.18, updated_at: "2026-04-17T00:15:00Z" },
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await handleValuationInputs(env);
    const body = await res.json() as any;
    expect(body.mvrv.z).toBeCloseTo(-1.8, 10);
  });
});
