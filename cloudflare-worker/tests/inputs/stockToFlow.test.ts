import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stockToFlow } from "../../src/valuation/inputs/stockToFlow";
import type { Env } from "../../src/lib/types";

const env = { PLANB_API_KEY: "test-key" } as unknown as Env;

describe("stockToFlow adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a key matching the composite INPUT_WEIGHTS key", () => {
    expect(stockToFlow.key).toBe("stock_to_flow");
  });

  it("fetchLatest parses the PlanB response and returns { timestamp, value }", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ t: 1744848000, s2f_deviation: -0.12 }] }), { status: 200 })
    );

    const reading = await stockToFlow.fetchLatest(env);

    expect(reading).not.toBeNull();
    expect(reading!.timestamp).toBe(1744848000);
    expect(reading!.value).toBeCloseTo(-0.12, 10);
  });

  it("fetchLatest returns null on upstream 5xx (does not throw)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    const reading = await stockToFlow.fetchLatest(env);
    expect(reading).toBeNull();
  });

  it("fetchLatest returns null on malformed response body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const reading = await stockToFlow.fetchLatest(env);
    expect(reading).toBeNull();
  });

  it("fetchHistory returns an array of readings sorted ascending by timestamp", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { t: 1744848000, s2f_deviation: -0.12 },
          { t: 1744761600, s2f_deviation: -0.10 },
        ],
      }), { status: 200 })
    );

    const readings = await stockToFlow.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].timestamp).toBeLessThan(readings[1].timestamp);
  });
});
