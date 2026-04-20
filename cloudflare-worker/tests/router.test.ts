import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import { saveCurrent } from "../src/valuation/persist";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("router", () => {
  it("dispatches GET /valuation/current", async () => {
    const kv = mockKV();
    await saveCurrent(kv, {
      z_score: 0, zone: "fair_value", multiplier: 1,
      updated_at: "2026-04-17T00:15:00Z", price_usd: 70000,
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/valuation/current"), env, {} as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.zone).toBe("fair_value");
  });

  it("dispatches GET /valuation/history with filters", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(
      new Request("https://w/valuation/history?since=2026-04-01"),
      env, {} as any,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("dispatches GET /valuation/inputs", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/valuation/inputs"), env, {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("keeps existing routes working (/recommended-peers)", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/recommended-peers"), env, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown paths", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/nope"), env, {} as any);
    expect(res.status).toBe(404);
  });

  it("dispatches POST /valuation/manual (rejects unsigned request)", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(
      new Request("https://w/valuation/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env, {} as any,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 on GET /valuation/manual (only POST is supported)", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/valuation/manual"), env, {} as any);
    expect(res.status).toBe(404);
  });
});
