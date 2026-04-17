import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGlassnodeMetric } from "../../src/valuation/inputs/glassnode";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("fetchGlassnodeMetric", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an URL using the given metric path and passes the API key header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 2.1 }]), { status: 200 })
    );
    const readings = await fetchGlassnodeMetric(env, "market/mvrv_z_score");
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("/v1/metrics/market/mvrv_z_score");
    expect((globalThis.fetch as any).mock.calls[0][1].headers["X-Api-Key"]).toBe("glass-key");
    expect(readings.length).toBe(1);
    expect(readings[0].timestamp).toBe(1744848000);
    expect(readings[0].value).toBeCloseTo(2.1, 10);
  });

  it("returns [] on missing API key (does not throw)", async () => {
    const readings = await fetchGlassnodeMetric({} as Env, "market/mvrv_z_score");
    expect(readings).toEqual([]);
    expect((globalThis.fetch as any)).not.toHaveBeenCalled?.();
  });

  it("returns [] on HTTP error", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 429 }));
    const readings = await fetchGlassnodeMetric(env, "market/mvrv_z_score");
    expect(readings).toEqual([]);
  });
});
