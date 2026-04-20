import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minerOutflows } from "../../src/valuation/inputs/minerOutflows";
import type { Env } from "../../src/lib/types";

const env = { CRYPTOQUANT_API_KEY: "cq-key" } as unknown as Env;

describe("minerOutflows adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'miner_outflows'", () => {
    expect(minerOutflows.key).toBe("miner_outflows");
  });

  it("parses CryptoQuant response shape", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        result: { data: [
          { datetime: "2026-04-16T00:00:00Z", flow_total: 1500 },
          { datetime: "2026-04-17T00:00:00Z", flow_total: 1200 },
        ]},
      }), { status: 200 })
    );
    const readings = await minerOutflows.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].value).toBe(1500);
    // Sorted ascending by timestamp
    expect(readings[0].timestamp).toBeLessThan(readings[1].timestamp);
  });

  it("passes the CryptoQuant bearer token header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { data: [] } }), { status: 200 })
    );
    await minerOutflows.fetchLatest(env);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer cq-key");
  });
});
