import { describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../../src/valuation/cron";
import * as engine from "../../src/valuation/engine";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("handleScheduled", () => {
  it("calls runEngine with current price and ISO timestamp", async () => {
    const spyPrice = vi.spyOn(engine, "fetchSpotPrice").mockResolvedValue(71434);
    const spyRun = vi.spyOn(engine, "runEngine").mockResolvedValue();

    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    await handleScheduled(env);

    expect(spyPrice).toHaveBeenCalled();
    expect(spyRun).toHaveBeenCalledOnce();
    const [, ctx] = spyRun.mock.calls[0];
    expect(ctx.priceUsd).toBe(71434);
    expect(ctx.nowISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    vi.restoreAllMocks();
  });

  it("tolerates a 0 price and still runs the engine", async () => {
    vi.spyOn(engine, "fetchSpotPrice").mockResolvedValue(0);
    const spyRun = vi.spyOn(engine, "runEngine").mockResolvedValue();
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    await handleScheduled(env);
    expect(spyRun).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
