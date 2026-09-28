// Daybreak power-law BANDS stamped at intake — spec §3.4.3, first tests 35 and
// 36 (bitcorn-research, specs/2026-09-21-bitcorn-daybreak-spec.md), Ruling 1
// of decisions/2026-09-25-daybreak-member-screen-seven-rulings.md.
//
// Every case goes through runDraftIntake and reads what intake actually PUT in
// KV, so a module that loads bands but never stamps them — or a read path that
// reads them live instead — cannot pass. Keys are string literals on purpose,
// as in intake.test.ts: this suite checks the stored shape, not what the code
// reports about it.
//
// The band labels below are TEST FIXTURES, not Kevin's labels. His calibration
// is owed and seeding the key is Ethan's; nothing here stands in for either.

import { describe, expect, it } from "vitest";
import type { CloseFetcher, CloseFetchResult, PriceSymbol } from "../../src/daybreak/closes";
import { runDraftIntake, WORKER_OWNED_KEY } from "../../src/daybreak/intake";
import { POWER_LAW_PARAMS_KV_KEY } from "../../src/valuation/powerLawParams";
import { computePowerLawZ } from "../../src/valuation/powerLawZ";
import { ORACLE_PARAMS } from "../fixtures/daybreakPowerLawOracle";

const BANDS_KEY = "daybreak_powerlaw_bands_v1";
const EDITION = "2026-09-29";
const CLOSE_DATE = "2026-09-28";
const FETCHED_AT = "2026-09-29T02:10:00.000Z";
const CORN = 4.12;
const BTC = 112_345.67;
const SECTIONS = { lead: "The Lead — agent draft", closer: "The Closer — agent draft" };

type Band = { lower: number | null; upper: number | null; label: string };

const TABLE: Band[] = [
  { lower: null, upper: -1, label: "Fixture band A" },
  { lower: -1, upper: -0.25, label: "Fixture band B" },
  { lower: -0.25, upper: 0.25, label: "Fixture band C" },
  { lower: 0.25, upper: 1, label: "Fixture band D" },
  { lower: 1, upper: null, label: "Fixture band E" },
];

function mockKV(seed: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: string[] = [];
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      puts.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

function ok(symbol: PriceSymbol, close: number): CloseFetchResult {
  return { ok: true, symbol, date: CLOSE_DATE, close, fetchedAt: FETCHED_AT };
}

const fetcher = (corn = CORN, btc = BTC): CloseFetcher => ({
  async latestCompletedClose(symbol) {
    return symbol === "ZC=F" ? ok("ZC=F", corn) : ok("BTC-USD", btc);
  },
});

function expectedZ(corn = CORN, btc = BTC): number {
  const r = computePowerLawZ({ date: CLOSE_DATE, corn, btc }, ORACLE_PARAMS);
  if (!r.ok) throw new Error(`fixture broken: ${r.detail}`);
  return r.value.z;
}

/** An independent reading of the table's rule (lower inclusive, null unbounded). */
function bandIndexFor(table: Band[], z: number): number {
  return table.findIndex((b) => (b.lower === null || z >= b.lower) && (b.upper === null || z < b.upper));
}

async function intakeWith(bands: string | null, closes: { corn?: number; btc?: number } = {}) {
  const seed: Record<string, string> = { [POWER_LAW_PARAMS_KV_KEY]: JSON.stringify(ORACLE_PARAMS) };
  if (bands !== null) seed[BANDS_KEY] = bands;
  const { kv, store, puts } = mockKV(seed);
  const result = await runDraftIntake({ kv, fetcher: fetcher(closes.corn, closes.btc) }, EDITION, SECTIONS);
  const raw = store.get(`daybreak:${EDITION}:draft`);
  expect(raw, "the draft must have been written").toBeDefined();
  const draft = JSON.parse(raw!) as Record<string, unknown>;
  const z = (draft[WORKER_OWNED_KEY] as Record<string, unknown>).z as Record<string, unknown>;
  return { result, z, puts };
}

const tableJson = (bands: unknown) => JSON.stringify({ bands });

// ─── Test 35: bands stamped at intake ──────────────────────────────────────

describe("test 35: bands are stamped into the Z block at intake", () => {
  it("permitting: with a valid table in KV, the STORED Z block carries the table and the Z's classified band", async () => {
    const { z } = await intakeWith(tableJson(TABLE));
    expect(z.status).toBe("available");
    const value = z.value as number;
    expect(value).toBeCloseTo(expectedZ(), 12);
    expect(z.bands).toEqual({ status: "available", table: TABLE, index: bandIndexFor(TABLE, value) });
  });

  it("anti-vacuity: the fixture's Z falls in a band the table can name (index ≥ 0)", async () => {
    const { z } = await intakeWith(tableJson(TABLE));
    expect(bandIndexFor(TABLE, z.value as number)).toBeGreaterThanOrEqual(0);
  });

  it("forbidding: with NO table, the Z is stamped WITHOUT a band — bands unavailable with a reason, never a guessed band", async () => {
    const { z, result } = await intakeWith(null);
    expect(result).toMatchObject({ ok: true, z: "available" });
    expect(z.status).toBe("available");
    expect(typeof z.value).toBe("number");
    expect(z.bands, "the stored Z block must carry a bands block").toBeDefined();
    const bands = z.bands as Record<string, unknown>;
    expect(bands.status).toBe("unavailable");
    expect(bands.reason).toBe("absent");
    expect("table" in bands).toBe(false);
    expect("index" in bands).toBe(false);
  });

  it("an unavailable Z carries NO bands at all — there is nothing to classify, and no number is stamped", async () => {
    const { kv, store } = mockKV({ [BANDS_KEY]: tableJson(TABLE) }); // params absent
    await runDraftIntake({ kv, fetcher: fetcher() }, EDITION, SECTIONS);
    const draft = JSON.parse(store.get(`daybreak:${EDITION}:draft`)!) as Record<string, any>;
    expect(draft[WORKER_OWNED_KEY].z.status).toBe("unavailable");
    expect("bands" in draft[WORKER_OWNED_KEY].z).toBe(false);
    expect(JSON.stringify(draft)).not.toContain("Fixture band");
  });

  it("intake never WRITES the band key — only the draft is put", async () => {
    const { puts } = await intakeWith(tableJson(TABLE));
    expect(puts).toEqual([`daybreak:${EDITION}:draft`]);
  });
});

// ─── Test 36: fail closed on each malformed shape ──────────────────────────

describe("test 36: bands fail closed on each malformed shape, and the Z is still present", () => {
  const cases: Array<[string, string | null, string]> = [
    ["absent", null, "absent"],
    ["unparseable", "{ not json", "unparseable"],
    ["wrong shape: a bare array", JSON.stringify(TABLE), "wrong_shape"],
    ["wrong shape: an empty table", tableJson([]), "wrong_shape"],
    ["wrong shape: a band with no label", tableJson([{ lower: null, upper: 0 }, { lower: 0, upper: null, label: "x" }]), "wrong_shape"],
    ["wrong shape: a string bound", tableJson([{ lower: null, upper: "0", label: "x" }, { lower: 0, upper: null, label: "y" }]), "wrong_shape"],
    ["wrong shape: closed at the low extreme", tableJson([{ lower: -5, upper: 0, label: "x" }, { lower: 0, upper: null, label: "y" }]), "wrong_shape"],
    ["wrong shape: closed at the high extreme", tableJson([{ lower: null, upper: 0, label: "x" }, { lower: 0, upper: 5, label: "y" }]), "wrong_shape"],
    [
      "unordered: bands out of sequence",
      tableJson([
        { lower: null, upper: -1, label: "a" },
        { lower: 0, upper: 1, label: "c" },
        { lower: -1, upper: 0, label: "b" },
        { lower: 1, upper: null, label: "d" },
      ]),
      "unordered",
    ],
    [
      "unordered: an inverted band",
      tableJson([
        { lower: null, upper: 1, label: "a" },
        { lower: 1, upper: 0, label: "b" },
        { lower: 0, upper: null, label: "c" },
      ]),
      "unordered",
    ],
    [
      "overlapping",
      tableJson([
        { lower: null, upper: 0.5, label: "a" },
        { lower: 0, upper: 1, label: "b" },
        { lower: 1, upper: null, label: "c" },
      ]),
      "overlapping",
    ],
    [
      "gapped",
      tableJson([
        { lower: null, upper: -0.5, label: "a" },
        { lower: 0, upper: 1, label: "b" },
        { lower: 1, upper: null, label: "c" },
      ]),
      "gapped",
    ],
  ];

  for (const [name, stored, reason] of cases) {
    it(`${name} → bands unavailable, reason ${reason}, Z still present, no classification`, async () => {
      const { z } = await intakeWith(stored);
      // permitting: the Z is still stamped
      expect(z.status).toBe("available");
      expect(z.value).toBeCloseTo(expectedZ(), 12);
      // permitting: its own reason code
      expect(z.bands, "the stored Z block must carry a bands block").toBeDefined();
    const bands = z.bands as Record<string, unknown>;
      expect(bands.status).toBe("unavailable");
      expect(bands.reason).toBe(reason);
      // forbidding: no classification and no table
      expect("index" in bands).toBe(false);
      expect("table" in bands).toBe(false);
    });
  }

  it("anti-vacuity: each malformed case differs from a valid table only in its defect — the valid one classifies", async () => {
    const { z } = await intakeWith(tableJson(TABLE));
    expect(z.bands, "the stored Z block must carry a bands block").toBeDefined();
    expect((z.bands as Record<string, unknown>).status).toBe("available");
  });

  it("a single open band (−∞, +∞) is a valid table and classifies every Z into it", async () => {
    const one = [{ lower: null, upper: null, label: "Only band" }];
    const { z } = await intakeWith(tableJson(one));
    expect(z.bands).toEqual({ status: "available", table: one, index: 0 });
  });
});

// ─── The lower bound is inclusive ──────────────────────────────────────────

describe("the lower bound is INCLUSIVE", () => {
  it("a Z exactly on a boundary is classified into the band ABOVE it", async () => {
    const z = expectedZ();
    const onBoundary: Band[] = [
      { lower: null, upper: z, label: "below" },
      { lower: z, upper: null, label: "at or above" },
    ];
    const { z: stamped } = await intakeWith(tableJson(onBoundary));
    expect(stamped.bands).toEqual({ status: "available", table: onBoundary, index: 1 });
  });

  it("anti-vacuity: nudging the boundary just above the Z moves it to the band below", async () => {
    const z = expectedZ();
    const above = z + 1e-9;
    const table: Band[] = [
      { lower: null, upper: above, label: "below" },
      { lower: above, upper: null, label: "at or above" },
    ];
    const { z: stamped } = await intakeWith(tableJson(table));
    expect(stamped.bands, "the stored Z block must carry a bands block").toBeDefined();
    expect((stamped.bands as { index: number }).index).toBe(0);
  });
});
