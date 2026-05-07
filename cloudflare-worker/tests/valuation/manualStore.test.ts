import { describe, expect, it } from "vitest";
import {
  MANUAL_KV_KEY,
  MANUAL_METRIC_KEYS,
  appendManualSubmission,
  loadManualHistory,
  type ManualValues,
} from "../../src/valuation/manualStore";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("MANUAL_METRIC_KEYS", () => {
  it("lists exactly the 9 manual-entry metrics", () => {
    expect(MANUAL_METRIC_KEYS).toEqual([
      "mvrv", "puell", "sopr", "reserve_risk",
      "nvt", "hash_ribbons", "difficulty_ribbon", "miner_outflows", "hodl_waves",
    ]);
  });
});

describe("appendManualSubmission + loadManualHistory", () => {
  it("appends one row per metric keyed by submission timestamp", async () => {
    const kv = mockKV();
    const values: ManualValues = {
      mvrv: 2.1, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
      nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, miner_outflows: 1500, hodl_waves: 0.15,
    };
    await appendManualSubmission(kv, "2026-04-17T14:32:00Z", values);

    const history = await loadManualHistory(kv);
    expect(Object.keys(history)).toEqual(MANUAL_METRIC_KEYS);
    expect(history.mvrv.length).toBe(1);
    expect(history.mvrv[0].value).toBeCloseTo(2.1, 10);
    // Unix-seconds conversion of the ISO timestamp
    expect(history.mvrv[0].timestamp).toBe(Math.floor(new Date("2026-04-17T14:32:00Z").getTime() / 1000));
  });

  it("a second submission appends another row", async () => {
    const kv = mockKV();
    const v1: ManualValues = { mvrv: 1, puell: 1, sopr: 1, reserve_risk: 1, nvt: 1, hash_ribbons: 1, difficulty_ribbon: 1, miner_outflows: 1, hodl_waves: 1 };
    const v2: ManualValues = { mvrv: 2, puell: 2, sopr: 2, reserve_risk: 2, nvt: 2, hash_ribbons: 2, difficulty_ribbon: 2, miner_outflows: 2, hodl_waves: 2 };
    await appendManualSubmission(kv, "2026-04-16T14:00:00Z", v1);
    await appendManualSubmission(kv, "2026-04-17T14:00:00Z", v2);
    const history = await loadManualHistory(kv);
    expect(history.mvrv.map((r) => r.value)).toEqual([1, 2]);
  });

  it("loadManualHistory returns empty series for each metric when nothing persisted", async () => {
    const kv = mockKV();
    const history = await loadManualHistory(kv);
    for (const k of MANUAL_METRIC_KEYS) {
      expect(history[k]).toEqual([]);
    }
  });

  it("KV key name is stable contract", () => {
    expect(MANUAL_KV_KEY).toBe("valuation_manual_v1");
  });
});
