import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCornHistory } from "../../src/handlers/prices";
import type { Env } from "../../src/lib/types";

// NASS QuickStats returns the NATIONAL row (state_name "US TOTAL") alongside
// one STATE row per reporting state for the same month — national first, then states
// alphabetically. The chart wants the national series only. This fixture keeps
// that order and the real agg_level_desc values, and the mocked fetch returns
// every row regardless of the query, so the output test exercises the parse
// filter on its own and the query test pins the request parameter on its own.
const AUG_2026_ROWS = [
  { year: 2026, reference_period_desc: "AUG", agg_level_desc: "NATIONAL", state_name: "US TOTAL", Value: "4.45" },
  { year: 2026, reference_period_desc: "AUG", agg_level_desc: "STATE", state_name: "IOWA", Value: "4.44" },
  { year: 2026, reference_period_desc: "AUG", agg_level_desc: "STATE", state_name: "WISCONSIN", Value: "4.28" },
];

// Fresh KV per test: the handler serves a 24h cache blob when present, which
// would let one test's write satisfy the next without a fetch.
function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return { PRICES_CACHE: mockKV(), USDA_NASS_KEY: "test-key" } as unknown as Env;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ data: AUG_2026_ROWS }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/prices/corn-history", () => {
  it("returns only the national price for a month that also has state rows", async () => {
    const res = await handleCornHistory(makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ year: number; month: number; price: number }>;

    expect(body.length).toBeGreaterThan(0);
    expect(body.map((e) => e.price)).toContain(4.45);

    const aug = body.filter((e) => e.year === 2026 && e.month === 8);
    expect(aug).toHaveLength(1);
    expect(aug[0].price).toBe(4.45);
  });

  it("asks NASS for national-level rows only", async () => {
    await handleCornHistory(makeEnv());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get("agg_level_desc")).toBe("NATIONAL");
  });
});
