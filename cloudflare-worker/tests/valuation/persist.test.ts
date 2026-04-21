import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_KV_KEY,
  HISTORY_KV_KEY,
  INPUTS_KV_KEY,
  loadCurrent,
  loadHistory,
  loadInputs,
  saveCurrent,
  saveHistory,
  saveInputs,
  type CurrentValuation,
  type HistoryRow,
  type InputSnapshot,
} from "../../src/valuation/persist";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("persist", () => {
  it("round-trips CurrentValuation", async () => {
    const kv = mockKV();
    const cv: CurrentValuation = {
      z_score: -1.44,
      zone: "undervalued",
      multiplier: 2.0,
      updated_at: "2026-04-17T00:15:00Z",
      price_usd: 71434,
    };
    await saveCurrent(kv, cv);
    const loaded = await loadCurrent(kv);
    expect(loaded).toEqual(cv);
  });

  it("returns null for missing current valuation", async () => {
    const kv = mockKV();
    expect(await loadCurrent(kv)).toBeNull();
  });

  it("round-trips history with stable ordering", async () => {
    const kv = mockKV();
    const rows: HistoryRow[] = [
      { date: "2026-04-15", z_score: -1.2, zone: "undervalued", price_usd: 71000 },
      { date: "2026-04-16", z_score: -1.3, zone: "undervalued", price_usd: 71200 },
      { date: "2026-04-17", z_score: -1.44, zone: "undervalued", price_usd: 71434 },
    ];
    await saveHistory(kv, rows);
    expect(await loadHistory(kv)).toEqual(rows);
  });

  it("round-trips input snapshots", async () => {
    const kv = mockKV();
    const snap: Record<string, InputSnapshot> = {
      mvrv: { value: 2.1, z: -1.8, weight: 0.18, updated_at: "2026-04-17T00:15:00Z" },
      puell: { value: 0.4, z: -1.2, weight: 0.10, updated_at: "2026-04-17T00:15:00Z" },
    };
    await saveInputs(kv, snap);
    expect(await loadInputs(kv)).toEqual(snap);
  });

  it("exports the exact KV key names the spec promised", () => {
    expect(CURRENT_KV_KEY).toBe("valuation_current_v1");
    expect(HISTORY_KV_KEY).toBe("valuation_history_v1");
    expect(INPUTS_KV_KEY).toBe("valuation_inputs_v1");
  });
});
