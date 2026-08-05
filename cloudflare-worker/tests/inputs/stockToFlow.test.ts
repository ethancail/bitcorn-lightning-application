import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stockToFlow } from "../../src/valuation/inputs/stockToFlow";
import type { Env } from "../../src/lib/types";

// stock-to-flow is `source: "derived"` — PlanB's api.planbtc.com went offline and
// the adapter now computes the deviation locally from BTC's deterministic supply
// schedule against the daily close series it gets from fetchBtcPriceHistory()
// (src/valuation/inputs/stockToFlow.ts:5-18). Two consequences for the fixture:
//
//   1. Env MUST carry PRICES_CACHE. Price history reads the KV cache first, so
//      an env without that binding throws TypeError before any assertion runs.
//      (The old fixture supplied only PLANB_API_KEY, which nothing reads now.)
//   2. The upstream to mock is Yahoo's chart endpoint, not PlanB — parallel
//      timestamp/close arrays in epoch seconds.
//
// Each test gets a FRESH KV. Price history writes a 12h cache blob on success,
// so a shared store would let the first test's write satisfy later tests without
// a fetch, and they would pass whether or not the code under test still worked.
function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return { PRICES_CACHE: mockKV() } as unknown as Env;
}

function yahooChart(points: Array<[number, number]>): Response {
  return new Response(JSON.stringify({
    chart: {
      result: [{
        timestamp: points.map(([t]) => t),
        indicators: { quote: [{ close: points.map(([, c]) => c) }] },
      }],
    },
  }), { status: 200 });
}

// Golden values for the published model, derived INDEPENDENTLY of the
// implementation (re-deriving the doc comment's formula, not calling the
// module) so these numbers check the model rather than echo the code:
//
//   SF          = supply / annual_issuance
//   model_price = exp(14.6) * SF^3.3 / supply
//   deviation   = (price - model_price) / model_price
//
// At t=1744848000 (2025-04-17T00:00:00Z): supply = 18,990,450 BTC,
// annual issuance = 164,362.5 BTC/yr, SF = 115.5400410677618,
// model_price = $739,914.414146858. The model reads far above spot post-2022 —
// a large negative deviation is the correct output, not a defect (see the
// "drifted bearishly" note at stockToFlow.ts:17).
const T_2025_04_17 = 1744848000;
const T_2025_04_16 = 1744761600;
const DEV_AT_30K = -0.95945477013771807; // price 30000 @ T_2025_04_17

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

  it("fetchLatest derives the deviation for the newest price point and returns { timestamp, value }", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      yahooChart([
        [T_2025_04_16, 29000],
        [T_2025_04_17, 30000],
      ]),
    );

    const reading = await stockToFlow.fetchLatest(makeEnv());

    expect(reading).not.toBeNull();
    // The LAST point of the series, not the first — fetchLatest returns
    // history[history.length - 1].
    expect(reading!.timestamp).toBe(T_2025_04_17);
    expect(reading!.value).toBeCloseTo(DEV_AT_30K, 10);
  });

  it("fetchLatest returns null on upstream 5xx (does not throw)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    const reading = await stockToFlow.fetchLatest(makeEnv());
    expect(reading).toBeNull();
  });

  it("fetchLatest returns null on malformed response body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const reading = await stockToFlow.fetchLatest(makeEnv());
    expect(reading).toBeNull();
  });

  it("fetchHistory returns an array of readings sorted ascending by timestamp", async () => {
    // Fed newest-first on purpose: the ascending order asserted below is
    // produced by the pipeline, not by the fixture already being in order.
    (globalThis.fetch as any).mockResolvedValueOnce(
      yahooChart([
        [T_2025_04_17, 30000],
        [T_2025_04_16, 29000],
      ]),
    );

    const readings = await stockToFlow.fetchHistory(makeEnv());
    expect(readings.length).toBe(2);
    expect(readings[0].timestamp).toBeLessThan(readings[1].timestamp);
  });
});
