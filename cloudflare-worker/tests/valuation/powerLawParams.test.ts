// Fail-closed contract of the Daybreak power-law params loader
// (src/valuation/powerLawParams.ts).
//
// Every rejection below is paired, in the same test, with a positive control:
// the SAME mock KV seeded with the well-formed value loads ok. That is what
// ties each "unavailable" to the defect under test rather than to a broken
// mock, a wrong key, or a loader that rejects everything.

import { describe, expect, it } from "vitest";
import { computePowerLawZ } from "../../src/valuation/powerLawZ";
import {
  POWER_LAW_PARAMS_KV_KEY,
  loadPowerLawParams,
  type PowerLawParamsLoad,
} from "../../src/valuation/powerLawParams";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  let puts = 0;
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      puts++;
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts: () => puts };
}

const GOOD = { a: 0.01404231115158245, b: 4.990628190592716, sigma: 0.2577628256677634, genesis: "2009-01-03" };
const GOOD_JSON = JSON.stringify(GOOD);

async function loadRaw(raw: string | undefined): Promise<PowerLawParamsLoad> {
  const { kv } = mockKV(raw === undefined ? {} : { [POWER_LAW_PARAMS_KV_KEY]: raw });
  return loadPowerLawParams(kv);
}

function expectUnavailable(res: PowerLawParamsLoad, reason: string, detailMentions?: string): void {
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.reason).toBe(reason);
  if (detailMentions) expect(res.detail).toContain(detailMentions);
  // No params ride along on a failure — nothing a caller could compute with.
  expect("params" in res).toBe(false);
}

async function expectGoodLoads(): Promise<void> {
  const res = await loadRaw(GOOD_JSON);
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.params).toEqual(GOOD);
}

describe("loadPowerLawParams — reads one key", () => {
  it("the key is daybreak_powerlaw_params_v1", () => {
    expect(POWER_LAW_PARAMS_KV_KEY).toBe("daybreak_powerlaw_params_v1");
  });

  it("well-formed value → usable params that reproduce the oracle's last row", async () => {
    const res = await loadRaw(GOOD_JSON);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params).toEqual(GOOD);
    // End to end: the loaded params compute the workbook's Z for 2026-09-21
    // (sheet row 4019), so "usable" means usable, not merely well-typed.
    const z = computePowerLawZ({ date: "2026-09-21", corn: 5.43, btc: 86000 }, res.params);
    expect(z.ok).toBe(true);
    if (z.ok) expect(Math.abs(z.value.z - -0.68904927911541192)).toBeLessThanOrEqual(1e-12);
  });

  it("extra keys are ignored and not carried into the result", async () => {
    const res = await loadRaw(JSON.stringify({ ...GOOD, note: "2026-09 refit" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.params).toEqual(GOOD);
  });

  it("never writes — the key is the operator's to seed", async () => {
    const { kv, puts } = mockKV({ [POWER_LAW_PARAMS_KV_KEY]: GOOD_JSON });
    const res = await loadPowerLawParams(kv);
    expect(res.ok).toBe(true);
    expect(puts()).toBe(0);
    const empty = mockKV();
    expectUnavailable(await loadPowerLawParams(empty.kv), "absent");
    expect(empty.puts()).toBe(0);
  });
});

describe("loadPowerLawParams — FAILS CLOSED", () => {
  it("absent key → unavailable (absent)", async () => {
    expectUnavailable(await loadRaw(undefined), "absent");
    await expectGoodLoads();
  });

  it("the right value under a different key → unavailable (absent)", async () => {
    const { kv } = mockKV({ daybreak_powerlaw_params_v2: GOOD_JSON, valuation_current_v1: GOOD_JSON });
    expectUnavailable(await loadPowerLawParams(kv), "absent");
    await expectGoodLoads();
  });

  it.each([
    ["truncated JSON", '{"a":0.014,"b":4.99'],
    ["empty string", ""],
    ["bare NaN", "NaN"],
    ["sigma = NaN literal", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":NaN,"genesis":"2009-01-03"}'],
    ["single-quoted keys", "{'a':1}"],
  ])("unparseable (%s) → unavailable (unparseable)", async (_label, raw) => {
    expectUnavailable(await loadRaw(raw), "unparseable");
    await expectGoodLoads();
  });

  it.each(["a", "b", "sigma", "genesis"])("missing field %s → unavailable (wrong_shape)", async (field) => {
    const partial: Record<string, unknown> = { ...GOOD };
    delete partial[field];
    expectUnavailable(await loadRaw(JSON.stringify(partial)), "wrong_shape", field);
    await expectGoodLoads();
  });

  it.each([
    ["array", "[]"],
    ["null", "null"],
    ["number", "0.2577628256677634"],
    ["string", '"params"'],
    ["sigma as numeric string (no coercion)", JSON.stringify({ ...GOOD, sigma: "0.2577628256677634" })],
    ["sigma = \"NaN\" string", JSON.stringify({ ...GOOD, sigma: "NaN" })],
    ["sigma = null", JSON.stringify({ ...GOOD, sigma: null })],
    ["genesis as a number", JSON.stringify({ ...GOOD, genesis: 39816 })],
  ])("wrong shape (%s) → unavailable (wrong_shape)", async (_label, raw) => {
    expectUnavailable(await loadRaw(raw), "wrong_shape");
    await expectGoodLoads();
  });

  it.each([
    ["sigma = 0", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":0,"genesis":"2009-01-03"}', "sigma"],
    ["sigma < 0", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":-0.25,"genesis":"2009-01-03"}', "sigma"],
    ["sigma overflows to Infinity", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":1e400,"genesis":"2009-01-03"}', "sigma"],
    ["a = 0", '{"a":0,"b":4.990628190592716,"sigma":0.2577628256677634,"genesis":"2009-01-03"}', "a "],
    ["b overflows to Infinity", '{"a":0.01404231115158245,"b":1e400,"sigma":0.2577628256677634,"genesis":"2009-01-03"}', "b "],
    ["impossible genesis date", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":0.2577628256677634,"genesis":"2009-02-30"}', "genesis"],
    ["genesis with a time", '{"a":0.01404231115158245,"b":4.990628190592716,"sigma":0.2577628256677634,"genesis":"2009-01-03T18:15:05Z"}', "genesis"],
  ])("invalid value (%s) → unavailable (invalid_value)", async (_label, raw, field) => {
    expectUnavailable(await loadRaw(raw), "invalid_value", field);
    await expectGoodLoads();
  });
});
