// Daybreak draft intake (src/daybreak/intake.ts) against a MOCK fetcher and a
// MOCK KV — intake depends on the CloseFetcher interface (src/daybreak/closes.ts),
// never on Yahoo.
//
// Numbered tests refer to the Daybreak spec's first-tests list (§3.4.1). Each
// has a PERMITTING case and a FORBIDDING case; every "X never appears" rides
// with a companion showing the same read could have seen X (§5.2).
//
// Keys are string literals on purpose, as in store.test.ts: this suite reads
// what intake actually put in KV, not what intake reports it put.

import { describe, expect, it } from "vitest";
import type { CloseFetcher, CloseFetchResult, PriceSymbol } from "../../src/daybreak/closes";
import { runDraftIntake, WORKER_OWNED_KEY } from "../../src/daybreak/intake";
import { POWER_LAW_PARAMS_KV_KEY } from "../../src/valuation/powerLawParams";
import { computePowerLawZ } from "../../src/valuation/powerLawZ";
import { ORACLE_PARAMS } from "../fixtures/daybreakPowerLawOracle";

type Op = { op: "get" | "put" | "delete"; key: string };

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const ops: Op[] = [];
  const kv = {
    async get(key: string) {
      ops.push({ op: "get", key });
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      ops.push({ op: "put", key });
      store.set(key, value);
    },
    async delete(key: string) {
      ops.push({ op: "delete", key });
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store, ops };
}

const PARAMS_JSON = JSON.stringify(ORACLE_PARAMS);
const withParams = () => mockKV({ [POWER_LAW_PARAMS_KV_KEY]: PARAMS_JSON });

type Canned = CloseFetchResult | (() => Promise<CloseFetchResult>);

function mockFetcher(canned: Record<PriceSymbol, Canned>) {
  const calls: PriceSymbol[] = [];
  const fetcher: CloseFetcher = {
    async latestCompletedClose(symbol) {
      calls.push(symbol);
      const c = canned[symbol];
      return typeof c === "function" ? c() : c;
    },
  };
  return { fetcher, calls };
}

const FETCHED_AT = "2026-09-29T02:10:00.000Z"; // Mon 21:10 CDT — the intake instant, never read by intake

function ok(symbol: PriceSymbol, date: string, close: number): CloseFetchResult {
  return { ok: true, symbol, date, close, fetchedAt: FETCHED_AT };
}

// Edition TUESDAY 2026-09-29, intake the evening of MONDAY 2026-09-28 (spec test 21).
const EDITION = "2026-09-29";
const CORN = 4.12;
const BTC = 112_345.67;

const SECTIONS = {
  lead: "The Lead — agent draft",
  kevinsRead: "Kevin's Read — agent draft",
  insideAgriculture: "Inside Agriculture — agent draft",
  worthReading: ["one", "two"],
  closer: "The Closer — agent draft",
};

function storedDraft(store: Map<string, string>, date = EDITION): Record<string, unknown> {
  const raw = store.get(`daybreak:${date}:draft`);
  expect(raw, `daybreak:${date}:draft must have been written`).toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}

function zBlockOf(draft: Record<string, unknown>): Record<string, unknown> {
  const owned = draft[WORKER_OWNED_KEY] as Record<string, unknown> | undefined;
  expect(owned, `draft must carry the reserved ${WORKER_OWNED_KEY} key`).toBeDefined();
  return owned!.z as Record<string, unknown>;
}

function expectedZ(date: string, corn = CORN, btc = BTC): number {
  const r = computePowerLawZ({ date, corn, btc }, ORACLE_PARAMS);
  if (!r.ok) throw new Error(`fixture broken: ${r.detail}`);
  return r.value.z;
}

// Every number anywhere in a value, with its JSON path.
function numbersIn(v: unknown, path = "$"): string[] {
  if (typeof v === "number") return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => numbersIn(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => numbersIn(x, `${path}.${k}`));
  return [];
}

async function intakeFresh(content: Record<string, unknown> = SECTIONS) {
  const { kv, store, ops } = withParams();
  const { fetcher, calls } = mockFetcher({
    "ZC=F": ok("ZC=F", "2026-09-28", CORN),
    "BTC-USD": ok("BTC-USD", "2026-09-28", BTC),
  });
  const result = await runDraftIntake({ kv, fetcher }, EDITION, content);
  return { result, store, ops, calls };
}

// ─── Test 13: fresh closes ────────────────────────────────────────────────

describe("test 13: fresh closes", () => {
  it("permitting: stamps the computed Z AND both close dates into the stored draft", async () => {
    const { result, store, calls } = await intakeFresh();
    expect(result).toMatchObject({ ok: true, z: "available" });
    expect(calls.sort()).toEqual(["BTC-USD", "ZC=F"]);
    const z = zBlockOf(storedDraft(store));
    expect(z.status).toBe("available");
    expect(z.value).toBeCloseTo(expectedZ("2026-09-28"), 12);
    expect(z.corn).toEqual({ date: "2026-09-28", close: CORN, fetchedAt: FETCHED_AT });
    expect(z.btc).toEqual({ date: "2026-09-28", close: BTC, fetchedAt: FETCHED_AT });
  });

  it("forbidding: a Z is never stored without both close dates, and never the reverse", async () => {
    const { store } = await intakeFresh();
    const z = zBlockOf(storedDraft(store));
    const hasZ = typeof z.value === "number";
    const cornDate = (z.corn as { date?: unknown } | undefined)?.date;
    const btcDate = (z.btc as { date?: unknown } | undefined)?.date;
    expect(hasZ).toBe(true); // anti-vacuity: this read can see a Z
    expect(typeof cornDate).toBe("string");
    expect(typeof btcDate).toBe("string");
  });

  it("the observation date for the trend is the LATER close date (weekend: Friday corn carried to Sunday's BTC)", async () => {
    // Monday 2026-09-28 edition: corn Fri 09-25 (3 days), BTC Sun 09-27 (1 day).
    const { kv, store } = withParams();
    const { fetcher } = mockFetcher({
      "ZC=F": ok("ZC=F", "2026-09-25", CORN),
      "BTC-USD": ok("BTC-USD", "2026-09-27", BTC),
    });
    expect((await runDraftIntake({ kv, fetcher }, "2026-09-28", SECTIONS)).ok).toBe(true);
    const z = zBlockOf(storedDraft(store, "2026-09-28"));
    expect(z.value).toBeCloseTo(expectedZ("2026-09-27"), 12);
    expect(z.value).not.toBeCloseTo(expectedZ("2026-09-25"), 12); // the two dates really give different Zs
  });

  it("the written sections are carried through untouched", async () => {
    const { store } = await intakeFresh();
    const { [WORKER_OWNED_KEY]: _owned, ...rest } = storedDraft(store);
    expect(rest).toEqual(SECTIONS);
  });
});

// ─── Test 14: a payload-supplied Z ────────────────────────────────────────

describe("test 14: a payload-supplied Z", () => {
  const PAYLOAD_Z = 9.99;
  const payload = {
    ...SECTIONS,
    [WORKER_OWNED_KEY]: {
      z: { status: "available", value: PAYLOAD_Z, corn: { date: "2020-01-01", close: 1 }, btc: { date: "2020-01-01", close: 1 } },
      marketSnapshot: { corn: 1 },
      injected: "by the drafting agent",
    },
  };

  it("anti-vacuity: the payload's Z differs from the computed one", () => {
    expect(Math.abs(PAYLOAD_Z - expectedZ("2026-09-28"))).toBeGreaterThan(1);
  });

  it("permitting: the stamped Z equals the COMPUTED one", async () => {
    const { store } = await intakeFresh(payload);
    expect(zBlockOf(storedDraft(store)).value).toBeCloseTo(expectedZ("2026-09-28"), 12);
  });

  it("forbidding: nothing the payload put under the reserved key survives — not its Z, its close dates, or any other field", async () => {
    const { store } = await intakeFresh(payload);
    const owned = storedDraft(store)[WORKER_OWNED_KEY] as Record<string, unknown>;
    expect(Object.keys(owned)).toEqual(["z"]);
    expect(JSON.stringify(owned)).not.toContain("2020-01-01");
    expect(JSON.stringify(owned)).not.toContain(String(PAYLOAD_Z));
  });

  it("forbidding: a payload Z is discarded on the FAILURE path too — it never stands in for an unavailable Z", async () => {
    const { kv, store } = mockKV(); // params absent
    const { fetcher } = mockFetcher({
      "ZC=F": ok("ZC=F", "2026-09-28", CORN),
      "BTC-USD": ok("BTC-USD", "2026-09-28", BTC),
    });
    await runDraftIntake({ kv, fetcher }, EDITION, payload);
    const owned = storedDraft(store)[WORKER_OWNED_KEY] as Record<string, unknown>;
    expect((owned.z as Record<string, unknown>).status).toBe("unavailable");
    expect(numbersIn(owned)).toEqual([]);
  });
});

// ─── Tests 15 + 21: staleness, measured from the EDITION's date (J.1) ──────

describe("test 21 (+15): staleness boundaries measured from the EDITION's Central date — edition Tue 2026-09-29, intake Mon 2026-09-28 evening", () => {
  async function run(cornDate: string, btcDate: string) {
    const { kv, store } = withParams();
    const { fetcher } = mockFetcher({
      "ZC=F": ok("ZC=F", cornDate, CORN),
      "BTC-USD": ok("BTC-USD", btcDate, BTC),
    });
    const result = await runDraftIntake({ kv, fetcher }, EDITION, SECTIONS);
    return { result, z: zBlockOf(storedDraft(store)) };
  }

  it("permitting: corn Fri 2026-09-25 (4 days) and BTC 2026-09-27 (2 days) are ACCEPTED — a Z is computed", async () => {
    const { result, z } = await run("2026-09-25", "2026-09-27");
    expect(result).toMatchObject({ ok: true, z: "available" });
    expect(z.status).toBe("available");
    expect(typeof z.value).toBe("number");
  });

  it("forbidding: corn Thu 2026-09-24 is 5 days from the edition → REJECTED, unavailable with a reason (from the intake date it would be 4 and accepted)", async () => {
    const { result, z } = await run("2026-09-24", "2026-09-27");
    expect(result).toMatchObject({ ok: true, z: "unavailable" });
    expect(z.status).toBe("unavailable");
    expect(z.reason).toBe("stale_close");
    expect(String(z.detail)).toContain("ZC=F");
    expect(String(z.detail)).toContain("2026-09-24");
    expect("value" in z).toBe(false);
  });

  it("forbidding: BTC 2026-09-26 is 3 days from the edition → REJECTED, unavailable with a reason (from the intake date it would be 2 and accepted)", async () => {
    const { result, z } = await run("2026-09-25", "2026-09-26");
    expect(result).toMatchObject({ ok: true, z: "unavailable" });
    expect(z.status).toBe("unavailable");
    expect(z.reason).toBe("stale_close");
    expect(String(z.detail)).toContain("BTC-USD");
    expect(String(z.detail)).toContain("2026-09-26");
    expect("value" in z).toBe(false);
  });

  it("forbidding: a close far past its bound (30 days) is never served as fresh", async () => {
    const { z } = await run("2026-08-30", "2026-09-28");
    expect(z.status).toBe("unavailable");
    expect(z.reason).toBe("stale_close");
  });
});

// ─── Tests 16 + 20: failures at intake → the draft is STILL WRITTEN (I.2) ──

describe("tests 16 + 20: a price failure at intake writes the draft with the Z UNAVAILABLE and a reason", () => {
  const fail = (symbol: PriceSymbol, reason: "http_error" | "unparseable" | "empty_series" | "network_error"): CloseFetchResult => ({
    ok: false,
    symbol,
    reason,
    detail: `${symbol} ${reason} (mock)`,
  });

  async function runWith(
    canned: Record<PriceSymbol, Canned>,
    seedParams: string | null = PARAMS_JSON,
    content: Record<string, unknown> = SECTIONS,
  ) {
    const { kv, store, ops } = mockKV(seedParams === null ? {} : { [POWER_LAW_PARAMS_KV_KEY]: seedParams });
    const { fetcher, calls } = mockFetcher(canned);
    const result = await runDraftIntake({ kv, fetcher }, EDITION, content);
    return { result, store, ops, calls };
  }

  function expectUnavailableDraft(store: Map<string, string>, reason: string) {
    const draft = storedDraft(store); // permitting: the draft IS written
    const { [WORKER_OWNED_KEY]: owned, ...rest } = draft;
    expect(rest).toEqual(SECTIONS); // written sections intact
    const z = (owned as Record<string, unknown>).z as Record<string, unknown>;
    expect(z.status).toBe("unavailable");
    expect(z.reason).toBe(reason);
    expect(typeof z.detail).toBe("string");
    expect((z.detail as string).length).toBeGreaterThan(0);
    // forbidding: no number anywhere in the stored draft — so no numeric Z can be rendered
    expect(numbersIn(draft)).toEqual([]);
  }

  it("anti-vacuity: the same number scan DOES find the Z on the success path", async () => {
    const { store } = await intakeFresh();
    expect(numbersIn(storedDraft(store))).toContain(`$.${WORKER_OWNED_KEY}.z.value`);
  });

  for (const reason of ["http_error", "unparseable", "empty_series", "network_error"] as const) {
    it(`corn fetch fails (${reason}) → draft written, Z unavailable: fetch_failed`, async () => {
      const { result, store } = await runWith({ "ZC=F": fail("ZC=F", reason), "BTC-USD": ok("BTC-USD", "2026-09-28", BTC) });
      expect(result).toMatchObject({ ok: true, z: "unavailable" });
      expectUnavailableDraft(store, "fetch_failed");
      expect(zBlockOf(storedDraft(store)).detail).toContain(`ZC=F ${reason}`);
    });
  }

  it("BTC fetch fails (HTTP 429) → draft written, Z unavailable: fetch_failed", async () => {
    const { store } = await runWith({
      "ZC=F": ok("ZC=F", "2026-09-28", CORN),
      "BTC-USD": { ok: false, symbol: "BTC-USD", reason: "http_error", detail: "HTTP 429" },
    });
    expectUnavailableDraft(store, "fetch_failed");
    expect(zBlockOf(storedDraft(store)).detail).toContain("HTTP 429");
  });

  it("a fetcher that THROWS is still a fetch failure → draft written, Z unavailable", async () => {
    const { result, store } = await runWith({
      "ZC=F": ok("ZC=F", "2026-09-28", CORN),
      "BTC-USD": async () => {
        throw new Error("socket hang up");
      },
    });
    expect(result).toMatchObject({ ok: true, z: "unavailable" });
    expectUnavailableDraft(store, "fetch_failed");
  });

  it("params ABSENT → draft written, Z unavailable: params_unavailable", async () => {
    const { result, store } = await runWith(
      { "ZC=F": ok("ZC=F", "2026-09-28", CORN), "BTC-USD": ok("BTC-USD", "2026-09-28", BTC) },
      null,
    );
    expect(result).toMatchObject({ ok: true, z: "unavailable" });
    expectUnavailableDraft(store, "params_unavailable");
  });

  it("params INVALID (σ = 0) → draft written, Z unavailable: params_unavailable", async () => {
    const { store } = await runWith(
      { "ZC=F": ok("ZC=F", "2026-09-28", CORN), "BTC-USD": ok("BTC-USD", "2026-09-28", BTC) },
      JSON.stringify({ ...ORACLE_PARAMS, sigma: 0 }),
    );
    expectUnavailableDraft(store, "params_unavailable");
  });

  it("an invalid computation (a zero corn close) → draft written, Z unavailable: computation_failed", async () => {
    const { store } = await runWith({ "ZC=F": ok("ZC=F", "2026-09-28", 0), "BTC-USD": ok("BTC-USD", "2026-09-28", BTC) });
    expectUnavailableDraft(store, "computation_failed");
  });

  it("a stale close → draft written, sections intact, Z unavailable: stale_close", async () => {
    const { store } = await runWith({ "ZC=F": ok("ZC=F", "2026-09-24", CORN), "BTC-USD": ok("BTC-USD", "2026-09-28", BTC) });
    expectUnavailableDraft(store, "stale_close");
  });

  it("forbidding: intake NEVER rejects the draft for a price failure — exactly one draft put, and nothing else written", async () => {
    const { result, ops } = await runWith(
      { "ZC=F": fail("ZC=F", "http_error"), "BTC-USD": fail("BTC-USD", "http_error") },
      null,
    );
    expect(result.ok).toBe(true);
    expect(ops.filter((o) => o.op !== "get")).toEqual([{ op: "put", key: `daybreak:${EDITION}:draft` }]);
  });
});

// ─── Ruling E: the edition date is explicit, never a clock ─────────────────

describe("the edition date is explicit (Ruling E)", () => {
  it("permitting: a stated date files under that date", async () => {
    const { store } = await intakeFresh();
    expect(store.has(`daybreak:${EDITION}:draft`)).toBe(true);
  });

  it("forbidding: a missing or malformed date is REJECTED, nothing is fetched and nothing is written", async () => {
    for (const bad of [undefined, "", "2026-9-29", "2026-02-30"]) {
      const { kv, ops } = withParams();
      const { fetcher, calls } = mockFetcher({
        "ZC=F": ok("ZC=F", "2026-09-28", CORN),
        "BTC-USD": ok("BTC-USD", "2026-09-28", BTC),
      });
      const result = await runDraftIntake({ kv, fetcher }, bad as unknown as string, SECTIONS);
      expect(result).toMatchObject({ ok: false, reason: "invalid_date" });
      expect(calls).toEqual([]);
      expect(ops.filter((o) => o.op === "put")).toEqual([]);
    }
  });

  it("forbidding: content that is not a plain object is REJECTED and nothing is written", async () => {
    for (const bad of [null, [], "text", new Map()]) {
      const { kv, ops } = withParams();
      const { fetcher } = mockFetcher({
        "ZC=F": ok("ZC=F", "2026-09-28", CORN),
        "BTC-USD": ok("BTC-USD", "2026-09-28", BTC),
      });
      const result = await runDraftIntake({ kv, fetcher }, EDITION, bad as unknown as Record<string, unknown>);
      expect(result).toMatchObject({ ok: false, reason: "invalid_content" });
      expect(ops.filter((o) => o.op === "put")).toEqual([]);
    }
  });
});
