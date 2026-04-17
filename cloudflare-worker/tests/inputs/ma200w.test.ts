import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ma200w } from "../../src/valuation/inputs/ma200w";
import type { Env } from "../../src/lib/types";

const env = { LOOKINTOBITCOIN_API_KEY: "test-key" } as unknown as Env;

describe("ma200w adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'ma_200w'", () => {
    expect(ma200w.key).toBe("ma_200w");
  });

  it("parses upstream response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { timestamp: 1744761600, pct_deviation: 1.45 },
          { timestamp: 1744848000, pct_deviation: 1.50 },
        ],
      }), { status: 200 })
    );
    const readings = await ma200w.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].value).toBeCloseTo(1.45, 10);
  });

  it("returns null on upstream failure", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await ma200w.fetchLatest(env)).toBeNull();
  });
});
