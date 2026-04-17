import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piCycle } from "../../src/valuation/inputs/piCycle";
import type { Env } from "../../src/lib/types";

const env = { LOOKINTOBITCOIN_API_KEY: "test-key" } as unknown as Env;

describe("piCycle adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'pi_cycle'", () => {
    expect(piCycle.key).toBe("pi_cycle");
  });

  it("parses upstream response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { timestamp: 1744761600, ratio: 0.8 },
          { timestamp: 1744848000, ratio: 0.85 },
        ],
      }), { status: 200 })
    );
    const readings = await piCycle.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[1].value).toBeCloseTo(0.85, 10);
  });

  it("returns null on upstream failure", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await piCycle.fetchLatest(env)).toBeNull();
  });
});
