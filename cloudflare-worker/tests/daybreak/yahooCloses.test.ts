// The Yahoo close adapter (src/daybreak/yahooCloses.ts) — spec §3.4.1, the
// adapter rulings of 2026-09-28 (1–4) and 2026-09-29 (A–D), and first tests
// 16, 17 and 57–64 (bitcorn-research, specs/2026-09-21-bitcorn-daybreak-spec.md).
// Each test has a PERMITTING and a FORBIDDING case (§5.1).
//
// FIXTURES are Yahoo's own bodies, captured through Firecrawl (not Cloudflare),
// headers not kept, bodies transcribed — provenance in fixtures/yahoo/README.md.
// Files named SYNTHETIC_* are derived, and so is every `variant(...)` below.
//
// CLOCKS are injected, never read: each case states the instant it runs at, in
// UTC with its Central wall time alongside.

import { describe, expect, it } from "vitest";
import { centralDateOf } from "../../src/daybreak/dates";
import type { CloseFetchResult, PriceSymbol } from "../../src/daybreak/closes";
import { YAHOO_USER_AGENT, barDate, createYahooCloseFetcher, yahooChartUrl } from "../../src/daybreak/yahooCloses";

import cornMonday1250 from "./fixtures/yahoo/zc-f_5d_2026-09-28_midday.json";
import cornMonday1mo from "./fixtures/yahoo/zc-f_1mo_2026-09-28.json";
import cornMondayAfternoon from "./fixtures/yahoo/zc-f_5d_2026-09-28_afternoon.json";
import cornTuesdayMidday from "./fixtures/yahoo/zc-f_5d_2026-09-29_midday.json";
import btc1mo from "./fixtures/yahoo/btc-usd_1mo_2026-09-28.json";
import btc5d from "./fixtures/yahoo/btc-usd_5d_2026-09-28.json";
import btcPlus0929 from "./fixtures/yahoo/SYNTHETIC_btc-usd_5d_plus-2026-09-29-bar.json";
import cornFallBack from "./fixtures/yahoo/SYNTHETIC_zc-f_5d_fall-back-2026-11-02.json";
import cornSpringForward from "./fixtures/yahoo/SYNTHETIC_zc-f_5d_spring-forward-2027-03-15.json";

const CORN: PriceSymbol = "ZC=F";
const BTC: PriceSymbol = "BTC-USD";

type Call = { url: string; init: RequestInit | undefined };

/** A fetch double serving one fixed response, recording every request. */
function serving(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

async function run(symbol: PriceSymbol, body: unknown, iso: string, status = 200): Promise<CloseFetchResult> {
  const { fetch } = serving(body, status);
  return createYahooCloseFetcher({ fetch, now: () => new Date(iso) }).latestCompletedClose(symbol);
}

/** A SYNTHETIC variant: a deep copy of a real fixture, patched in place. */
function variant(base: unknown, patch: (result: any, chart: any) => void): unknown {
  const copy = structuredClone(base) as any;
  patch(copy.chart.result[0], copy.chart);
  return copy;
}

function expectClose(r: CloseFetchResult, date: string, close: number) {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) return;
  expect(r.date).toBe(date);
  expect(r.close).toBe(close);
}

function expectFailure(r: CloseFetchResult, reason: string) {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (r.ok) return;
  expect(r.reason).toBe(reason);
  expect("close" in r).toBe(false);
  expect("date" in r).toBe(false);
}

// ─── The request ─────────────────────────────────────────────────────────

describe("one request per symbol, to the chart endpoint, with the adapter's own User-Agent", () => {
  it("permitting: exactly one GET, range=5d, interval=1d, the symbol URL-encoded", async () => {
    for (const [symbol, body, want] of [
      [CORN, cornMondayAfternoon, "https://query1.finance.yahoo.com/v8/finance/chart/ZC%3DF?range=5d&interval=1d"],
      [BTC, btc5d, "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=5d&interval=1d"],
    ] as const) {
      const { fetch, calls } = serving(body);
      await createYahooCloseFetcher({ fetch, now: () => new Date("2026-09-28T19:30:00Z") }).latestCompletedClose(symbol);
      expect(calls.map((c) => c.url)).toEqual([want]);
      expect(yahooChartUrl(symbol)).toBe(want);
      expect(new Headers(calls[0].init?.headers).get("User-Agent")).toBe(YAHOO_USER_AGENT);
    }
  });

  it("forbidding: a browser-like User-Agent is always sent — never the runtime's default", async () => {
    // valuation/inputs/priceHistory.ts:16-18 records that Yahoo 429s without one.
    expect(YAHOO_USER_AGENT).toMatch(/^Mozilla\/5\.0 /);
    const { fetch, calls } = serving(btc5d);
    await createYahooCloseFetcher({ fetch, now: () => new Date("2026-09-28T19:30:00Z") }).latestCompletedClose(BTC);
    expect(new Headers(calls[0].init?.headers).get("User-Agent")).not.toBeNull();
  });
});

// ─── Test 57: units ──────────────────────────────────────────────────────

describe("test 57: units, keyed on meta.currency", () => {
  // The 12:50 PM capture's Monday bar is 523.25 USX. At 2:00 PM CDT (19:00Z)
  // it is past 1:20 PM, so that bar is the one chosen.
  const AFTER_CLOSE = "2026-09-28T19:00:00Z";

  it("permitting: a USX close of 523.25 yields 5.2325 ($/bu)", async () => {
    expect((cornMonday1250 as any).chart.result[0].meta.currency).toBe("USX");
    expectClose(await run(CORN, cornMonday1250, AFTER_CLOSE), "2026-09-28", 5.2325);
  });

  it("forbidding: a USX close is never returned undivided", async () => {
    const r = await run(CORN, cornMonday1250, AFTER_CLOSE);
    expect(r.ok && r.close).not.toBe(523.25);
  });

  it("anti-vacuity: the same fixture with USD in place of USX returns the undivided number", async () => {
    const usd = variant(cornMonday1250, (res) => (res.meta.currency = "USD"));
    expectClose(await run(CORN, usd, AFTER_CLOSE), "2026-09-28", 523.25);
  });

  it("permitting: Bitcoin's USD close is returned unchanged", async () => {
    expect((btc1mo as any).chart.result[0].meta.currency).toBe("USD");
    expectClose(await run(BTC, btc1mo, "2026-09-28T18:01:14Z"), "2026-09-27", 84458.0859375);
  });

  it("forbidding: any other currency — EUR, empty, absent, non-string, lowercase — fails closed with no value", async () => {
    const cases: Array<[string, (res: any) => void]> = [
      ["EUR", (res) => (res.meta.currency = "EUR")],
      ["empty", (res) => (res.meta.currency = "")],
      ["absent", (res) => delete res.meta.currency],
      ["null", (res) => (res.meta.currency = null)],
      ["number", (res) => (res.meta.currency = 100)],
      ["lowercase usx", (res) => (res.meta.currency = "usx")],
      ["prototype key", (res) => (res.meta.currency = "toString")],
    ];
    for (const [label, patch] of cases) {
      const r = await run(CORN, variant(cornMonday1250, patch), AFTER_CLOSE);
      expect(r.ok, label).toBe(false);
      expectFailure(r, "unsupported_currency");
    }
  });
});

// ─── Test 58: a bar's date ───────────────────────────────────────────────

describe("test 58: a bar's date is its timestamp's UTC date", () => {
  it("permitting: corn 1790568000 (NY midnight) and Bitcoin 1790553600 (UTC midnight) are both 2026-09-28", () => {
    expect(barDate(1790568000)).toBe("2026-09-28");
    expect(barDate(1790553600)).toBe("2026-09-28");
  });

  it("permitting, end to end: the dates the adapter returns are the bars' UTC dates", async () => {
    // Corn at 2:30 PM CDT Monday → the Monday bar (1790568000).
    expectClose(await run(CORN, cornMondayAfternoon, "2026-09-28T19:30:00Z"), "2026-09-28", 5.2225);
    // Bitcoin at 10 PM CDT Monday → the 09-28 UTC bar (1790553600).
    expectClose(await run(BTC, btc5d, "2026-09-29T03:00:00Z"), "2026-09-28", 83843.0703125);
  });

  it("forbidding: neither is ever dated 2026-09-27", async () => {
    expect(barDate(1790568000)).not.toBe("2026-09-27");
    expect(barDate(1790553600)).not.toBe("2026-09-27");
    const corn = await run(CORN, cornMondayAfternoon, "2026-09-28T19:30:00Z");
    const btc = await run(BTC, btc5d, "2026-09-29T03:00:00Z");
    expect(corn.ok && corn.date).not.toBe("2026-09-27");
    expect(btc.ok && btc.date).not.toBe("2026-09-27");
  });

  it("anti-vacuity: centralDateOf on the same two timestamps gives 2026-09-27 — the trap is real", () => {
    expect(centralDateOf(new Date(1790568000 * 1000))).toBe("2026-09-27");
    expect(centralDateOf(new Date(1790553600 * 1000))).toBe("2026-09-27");
  });
});

// ─── Test 59: Bitcoin's in-progress bar ──────────────────────────────────

describe("test 59: Bitcoin's in-progress bar is never returned", () => {
  it("permitting: at Mon 22:00 CDT (09-29T03:00Z), with 09-28 and 09-29 bars, the 09-28 close is returned", async () => {
    expectClose(await run(BTC, btcPlus0929, "2026-09-29T03:00:00Z"), "2026-09-28", 83843.0703125);
  });

  it("forbidding: the 09-29 bar, whose UTC day contains the clock, is never returned", async () => {
    const r = await run(BTC, btcPlus0929, "2026-09-29T03:00:00Z");
    expect(r.ok && r.close).not.toBe(99999.5);
    expect(r.ok && r.date).not.toBe("2026-09-29");
  });

  it("anti-vacuity: at 2026-09-30T01:00Z the 09-29 bar IS returned — the exclusion follows the clock", async () => {
    expectClose(await run(BTC, btcPlus0929, "2026-09-30T01:00:00Z"), "2026-09-29", 99999.5);
  });

  it("real capture: the 1mo body at its own capture time (Mon 13:01:14 CDT) → the 09-27 close, dated 2026-09-27", async () => {
    const at = new Date(1790618474 * 1000).toISOString(); // its regularMarketTime
    expect(at).toBe("2026-09-28T18:01:14.000Z");
    expectClose(await run(BTC, btc1mo, at), "2026-09-27", 84458.0859375);
    const r = await run(BTC, btc1mo, at);
    expect(r.ok && r.close).not.toBe(83843.0703125); // the in-progress 09-28 bar
  });

  it("the UTC-day boundary: 23:59:59Z on 09-28 excludes the 09-28 bar; 00:00:00Z on 09-29 admits it", async () => {
    expectClose(await run(BTC, btc5d, "2026-09-28T23:59:59Z"), "2026-09-27", 84458.0859375);
    expectClose(await run(BTC, btc5d, "2026-09-29T00:00:00Z"), "2026-09-28", 83843.0703125);
  });
});

// ─── Tests 60 and 64: a null or non-finite chosen close ──────────────────

/** A 200 whose parsed body is `body` exactly — how a NaN, which JSON cannot carry, reaches the adapter. */
function servingParsed(body: unknown) {
  return async () => ({ status: 200, json: async () => body }) as unknown as Response;
}

describe("test 60: Bitcoin — a null or non-finite close on the chosen bar fails closed, with no fallback", () => {
  const AT = "2026-09-28T18:01:14Z"; // the chosen bar is 09-27 (index 3 of the 5d body)
  const withClose = (v: unknown) => variant(btc5d, (res) => (res.indicators.quote[0].close[3] = v));

  it("permitting: the chosen bar's finite close is returned", async () => {
    expectClose(await run(BTC, btc5d, AT), "2026-09-27", 84458.0859375);
  });

  it("forbidding: null, Infinity, -Infinity and a string fail closed — 09-26's close is never returned", async () => {
    for (const v of [null, "1e999", "-1e999", '"84458"']) {
      const raw = JSON.stringify(withClose("__V__")).replace('"__V__"', v === null ? "null" : v);
      const r = await run(BTC, raw, AT);
      expectFailure(r, "invalid_close");
      expect(JSON.stringify(r)).not.toContain("84406.453125"); // 09-26
    }
  });

  it("forbidding: NaN fails closed", async () => {
    const r = await createYahooCloseFetcher({ fetch: servingParsed(withClose(NaN)), now: () => new Date(AT) }).latestCompletedClose(BTC);
    expectFailure(r, "invalid_close");
  });
});

describe("test 64: corn — a null or non-finite close on the SELECTED bar fails closed, with no fallback", () => {
  const AT = "2026-09-28T19:30:00Z"; // 2:30 PM CDT — the Monday bar (index 3) is finished
  const withClose = (v: unknown) => variant(cornMondayAfternoon, (res) => (res.indicators.quote[0].close[3] = v));

  it("permitting: with the Monday bar finished and finite, its close is returned ÷100", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, AT), "2026-09-28", 5.2225);
  });

  it("forbidding: a null or infinite Monday close after 1:20 PM fails closed — Friday's is never returned", async () => {
    for (const v of ["null", "1e999", "-1e999"]) {
      const raw = JSON.stringify(withClose("__V__")).replace('"__V__"', v);
      const r = await run(CORN, raw, AT);
      expectFailure(r, "invalid_close");
      expect(JSON.stringify(r)).not.toContain("5.2825");
    }
  });

  it("forbidding: NaN fails closed", async () => {
    const r = await createYahooCloseFetcher({ fetch: servingParsed(withClose(NaN)), now: () => new Date(AT) }).latestCompletedClose(CORN);
    expectFailure(r, "invalid_close");
  });

  it("anti-vacuity: a null on a bar the rule does NOT choose is harmless", async () => {
    const nullFriday = variant(cornMondayAfternoon, (res) => (res.indicators.quote[0].close[2] = null));
    expectClose(await run(CORN, nullFriday, AT), "2026-09-28", 5.2225);
  });
});

// ─── Tests 61–63 and the real corn captures: the 1:20 PM rule ────────────

describe("corn's finished close, from the real captures", () => {
  it("the 12:50 PM Monday capture, at its own capture time → Friday's close (the Monday bar is still in progress)", async () => {
    for (const [body, rmt] of [
      [cornMonday1250, 1790617841],
      [cornMonday1mo, 1790617855],
    ] as const) {
      expect((body as any).chart.result[0].meta.regularMarketTime).toBe(rmt);
      const at = new Date(rmt * 1000).toISOString(); // Mon 12:50 CDT
      expectClose(await run(CORN, body, at), "2026-09-25", 5.2825);
    }
  });

  it("forbidding: at 12:50 PM the in-progress Monday value is never returned", async () => {
    const r = await run(CORN, cornMonday1250, "2026-09-28T17:50:41Z");
    expect(r.ok && r.close).not.toBe(5.2325);
    expect(r.ok && r.date).not.toBe("2026-09-28");
  });

  it("the ~2:30 PM Monday capture → Monday's close, 522.25 cents → $5.2225", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, "2026-09-28T19:30:00Z"), "2026-09-28", 5.2225);
  });

  it("the Tuesday midday capture (12:36 CDT) → Monday's settlement, 523.0 cents → $5.23 — not Tuesday's in-progress bar", async () => {
    const at = new Date(1790703390 * 1000).toISOString();
    const r = await run(CORN, cornTuesdayMidday, at);
    expectClose(r, "2026-09-28", 5.23);
    expect(r.ok && r.close).not.toBe(5.225); // Tuesday's 522.5
  });
});

describe("test 61: the 1:20 PM boundary", () => {
  it("permitting: at 1:19:59 PM CDT the Monday bar is not finished → Friday's close, dated 2026-09-25", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, "2026-09-28T18:19:59Z"), "2026-09-25", 5.2825);
  });

  it("forbidding: at 1:19:59 PM the Monday close is never returned", async () => {
    const r = await run(CORN, cornMondayAfternoon, "2026-09-28T18:19:59Z");
    expect(r.ok && r.date).not.toBe("2026-09-28");
  });

  it("permitting: at 1:20:00 PM CDT exactly it counts as passed → Monday's close, dated 2026-09-28", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, "2026-09-28T18:20:00Z"), "2026-09-28", 5.2225);
  });

  it("forbidding: at 1:20:00 PM the Friday close is not returned", async () => {
    const r = await run(CORN, cornMondayAfternoon, "2026-09-28T18:20:00Z");
    expect(r.ok && r.date).not.toBe("2026-09-25");
  });
});

describe("test 62: across both daylight-saving changes (SYNTHETIC timestamps)", () => {
  it("fall-back week, Mon 2026-11-02 (CST): 19:19:59Z not finished, 19:20:00Z finished", async () => {
    expect(barDate(1793595600)).toBe("2026-11-02"); // 05:00Z — New York midnight in EST
    expectClose(await run(CORN, cornFallBack, "2026-11-02T19:19:59Z"), "2026-10-30", 5.2825);
    expectClose(await run(CORN, cornFallBack, "2026-11-02T19:20:00Z"), "2026-11-02", 5.2225);
  });

  it("forbidding: at 2026-11-02T18:20:00Z (12:20 PM CST — 1:20 on a fixed CDT offset) it is NOT finished", async () => {
    const r = await run(CORN, cornFallBack, "2026-11-02T18:20:00Z");
    expectClose(r, "2026-10-30", 5.2825);
  });

  it("spring-forward week, Mon 2027-03-15 (CDT): 18:19:59Z not finished, 18:20:00Z finished", async () => {
    expect(barDate(1805083200)).toBe("2027-03-15"); // 04:00Z — New York midnight in EDT
    expectClose(await run(CORN, cornSpringForward, "2027-03-15T18:19:59Z"), "2027-03-12", 5.2825);
    expectClose(await run(CORN, cornSpringForward, "2027-03-15T18:20:00Z"), "2027-03-15", 5.2225);
  });

  it("forbidding: the rule does not wait until 19:20:00Z (a fixed CST offset) — at 18:50Z Monday is already returned", async () => {
    expectClose(await run(CORN, cornSpringForward, "2027-03-15T18:50:00Z"), "2027-03-15", 5.2225);
  });
});

describe("test 63: at 10 PM, before Yahoo opens the next bar", () => {
  it("permitting: the ~2:30 PM capture with the clock at Mon 10 PM CDT (09-29T03:00Z) → still Monday's close", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, "2026-09-29T03:00:00Z"), "2026-09-28", 5.2225);
  });

  it("forbidding: it is not dropped in favour of Friday (C4's and C1's error)", async () => {
    const r = await run(CORN, cornMondayAfternoon, "2026-09-29T03:00:00Z");
    expect(r.ok && r.date).not.toBe("2026-09-25");
    expect(r.ok && r.close).not.toBe(5.2825);
  });

  it("anti-vacuity: at 11:30 PM CDT (09-29T04:30Z), with a 09-29 bar present and in progress, the result is STILL Monday's", async () => {
    // The Tuesday capture's structure — a 09-29 bar after the Monday one — at an earlier clock.
    expectClose(await run(CORN, cornTuesdayMidday, "2026-09-29T04:30:00Z"), "2026-09-28", 5.23);
  });
});

// ─── Test 16: fetch failures fail closed ─────────────────────────────────

describe("test 16: every fetch failure is an explicit failure with no value", () => {
  const AT = "2026-09-28T19:30:00Z";

  it("permitting (anti-vacuity): the same fixture served 200 succeeds", async () => {
    expectClose(await run(CORN, cornMondayAfternoon, AT), "2026-09-28", 5.2225);
  });

  it("forbidding: a 429 — Yahoo's refusal, body as captured 2026-09-28 — fails closed as http_error", async () => {
    for (const symbol of [CORN, BTC]) {
      const r = await run(symbol, "Too Many Requests", AT, 429);
      expectFailure(r, "http_error");
      expect(!r.ok && r.detail).toContain("429");
    }
  });

  it("forbidding: any non-200 — even one carrying a valid chart body — fails closed", async () => {
    for (const status of [201, 204, 301, 404, 500, 503]) {
      const body = status === 204 ? null : JSON.stringify(cornMondayAfternoon);
      const fetch = async () => new Response(body, { status });
      const r = await createYahooCloseFetcher({ fetch, now: () => new Date(AT) }).latestCompletedClose(CORN);
      expectFailure(r, "http_error");
    }
  });

  it("forbidding: a network error fails closed as network_error", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const r = await createYahooCloseFetcher({ fetch, now: () => new Date(AT) }).latestCompletedClose(CORN);
    expectFailure(r, "network_error");
  });

  it("forbidding: a 200 that is not JSON, or JSON of the wrong shape, fails closed as unparseable", async () => {
    const bodies = [
      "Too Many Requests",
      "",
      "[]",
      JSON.stringify({ chart: {} }),
      JSON.stringify({ chart: { result: [], error: null } }),
      JSON.stringify(variant(cornMondayAfternoon, (res) => delete res.meta)),
      JSON.stringify(variant(cornMondayAfternoon, (res) => delete res.timestamp)),
      JSON.stringify(variant(cornMondayAfternoon, (res) => delete res.indicators.quote)),
      JSON.stringify(variant(cornMondayAfternoon, (res) => (res.timestamp[1] = "1790222400"))),
    ];
    for (const body of bodies) expectFailure(await run(CORN, body, AT), "unparseable");
  });

  it("forbidding: a non-null chart.error fails closed as chart_error", async () => {
    const withError = variant(cornMondayAfternoon, (_res, chart) => (chart.error = { code: "Not Found", description: "No data found" }));
    expectFailure(await run(CORN, withError, AT), "chart_error");
  });

  it("forbidding: timestamp and close arrays of unequal length fail closed as unequal_arrays", async () => {
    for (const patch of [(res: any) => res.indicators.quote[0].close.pop(), (res: any) => res.timestamp.pop()]) {
      expectFailure(await run(CORN, variant(cornMondayAfternoon, patch), AT), "unequal_arrays");
    }
  });

  it("forbidding: an empty series fails closed as empty_series", async () => {
    const empty = variant(cornMondayAfternoon, (res) => {
      res.timestamp = [];
      res.indicators.quote[0].close = [];
    });
    expectFailure(await run(CORN, empty, AT), "empty_series");
  });

  it("forbidding: a series with no finished bar fails closed as no_finished_bar", async () => {
    // Bitcoin at 09-24T12:00Z: the 5d body's earliest bar is 09-24, which contains the clock.
    expectFailure(await run(BTC, btc5d, "2026-09-24T12:00:00Z"), "no_finished_bar");
  });

  it("forbidding: nothing is cached — a 429 after a success returns no value, not the earlier one", async () => {
    let status = 200;
    const fetch = async () => (status === 200 ? new Response(JSON.stringify(cornMondayAfternoon)) : new Response("Too Many Requests", { status }));
    const fetcher = createYahooCloseFetcher({ fetch, now: () => new Date(AT) });
    expectClose(await fetcher.latestCompletedClose(CORN), "2026-09-28", 5.2225);
    status = 429;
    expectFailure(await fetcher.latestCompletedClose(CORN), "http_error");
  });
});

// ─── Test 17: a success reports its age ──────────────────────────────────

describe("test 17: a successful fetch reports its date, and fetchedAt is the injected clock", () => {
  it("permitting: the result carries the chosen bar's date, and fetchedAt is the clock, to the millisecond", async () => {
    const r = await run(CORN, cornMondayAfternoon, "2026-09-28T19:30:00.123Z");
    expectClose(r, "2026-09-28", 5.2225);
    expect(r.ok && r.fetchedAt).toBe("2026-09-28T19:30:00.123Z");
    expect(r.ok && r.symbol).toBe(CORN);
  });

  it("forbidding: fetchedAt is never a time from the response (regularMarketTime 13:20:00 CDT)", async () => {
    const r = await run(CORN, cornMondayAfternoon, "2026-09-28T19:30:00.123Z");
    expect(r.ok && r.fetchedAt).not.toBe(new Date(1790619600 * 1000).toISOString());
  });
});
