// Drive-mode P3 (R40(8); R15(5)): the read-only fee sampler and "calm".
//   - at most one sample per 10 minutes; samples older than 8 days dropped;
//     a failed read stores nothing
//   - calm = the current 6-block estimate at or below its 7-day MEDIAN
//   - "unknown" until the samples span 7 days, and when no current estimate
// Samples are injected: on regtest the estimate is constant.
//
// Harness: real migrations on a temp-dir DB; the lnd read is injected.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-fee-samples-"));
process.env.DB_DIR = TMP_DB;
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { maybeSampleFeeEstimate, calmReading, median, SAMPLE_INTERVAL_MS, KEEP_MS, CALM_WINDOW_MS } = await import("./feeSamples");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));
beforeEach(() => { db.prepare("DELETE FROM fee_estimate_samples").run(); });

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const put = (at: number, rate: number) =>
  db.prepare("INSERT INTO fee_estimate_samples (sampled_at, sat_per_vbyte) VALUES (?, ?)").run(at, rate);
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM fee_estimate_samples").get() as { n: number }).n;
const rate = (n: number) => async () => ({ tokens_per_vbyte: n });

describe("the sampler", () => {
  it("stores a first sample", async () => {
    expect(await maybeSampleFeeEstimate(NOW, rate(12))).toBe(true);
    expect(count()).toBe(1);
  });

  it("skips while the last sample is under 10 minutes old, samples once it is", async () => {
    await maybeSampleFeeEstimate(NOW, rate(12));
    expect(await maybeSampleFeeEstimate(NOW + SAMPLE_INTERVAL_MS - 1, rate(13))).toBe(false);
    expect(await maybeSampleFeeEstimate(NOW + SAMPLE_INTERVAL_MS, rate(13))).toBe(true);
    expect(count()).toBe(2);
  });

  it("drops samples older than 8 days", async () => {
    put(NOW - KEEP_MS - 1, 5);
    put(NOW - KEEP_MS + 1, 6);
    await maybeSampleFeeEstimate(NOW, rate(7));
    const kept = db.prepare("SELECT sat_per_vbyte FROM fee_estimate_samples ORDER BY sampled_at").all();
    expect(kept).toEqual([{ sat_per_vbyte: 6 }, { sat_per_vbyte: 7 }]);
  });

  it("a failed read stores nothing", async () => {
    expect(await maybeSampleFeeEstimate(NOW, async () => { throw new Error("lnd down"); })).toBe(false);
    expect(count()).toBe(0);
  });

  it("calls lnd at most once per interval (rate limit holds across many ticks)", async () => {
    let calls = 0;
    const read = async () => { calls++; return { tokens_per_vbyte: 9 }; };
    for (let t = 0; t < 40; t++) await maybeSampleFeeEstimate(NOW + t * 15_000, read); // 10 minutes of 15 s ticks
    expect(calls).toBe(1);
  });
});

describe("median", () => {
  it("odd count: the middle value", () => expect(median([9, 1, 5])).toBe(5));
  it("even count: the mean of the middle two", () => expect(median([1, 2, 10, 11])).toBe(6));
});

/** Seven days and a bit of 10-minute samples, then a current one. */
function history(values: (i: number) => number, current: number) {
  const n = Math.floor((CALM_WINDOW_MS + DAY / 2) / SAMPLE_INTERVAL_MS);
  for (let i = n; i >= 1; i--) put(NOW - i * SAMPLE_INTERVAL_MS, values(i));
  put(NOW, current);
}

describe("calm (R15(5))", () => {
  it("unknown before 7 days of history, whatever the estimate", () => {
    for (let i = 0; i < 6 * 144; i++) put(NOW - i * SAMPLE_INTERVAL_MS, 50);
    put(NOW, 1);
    const r = calmReading(NOW);
    expect(r.state).toBe("unknown");
    expect(r.state === "unknown" && r.reason).toBe("not_enough_history");
  });

  it("calm when the current estimate is at or below the 7-day median", () => {
    history(() => 10, 10);
    expect(calmReading(NOW).state).toBe("calm");
  });

  it("not calm above the median", () => {
    history(() => 10, 11);
    expect(calmReading(NOW).state).toBe("not_calm");
  });

  it("the MEDIAN, not the mean: a few fee spikes do not make a high estimate calm", () => {
    // Mostly 10 sat/vB, with ~10% of samples at 200. Mean ≈ 29, median 10.
    history((i) => (i % 10 === 0 ? 200 : 10), 20);
    const r = calmReading(NOW);
    expect(r.state).toBe("not_calm");
    expect(r.state !== "unknown" && r.median).toBe(10);
  });

  it("unknown when the latest sample is stale (no current estimate)", () => {
    history(() => 10, 10);
    const r = calmReading(NOW + 3 * SAMPLE_INTERVAL_MS);
    expect(r.state).toBe("unknown");
    expect(r.state === "unknown" && r.reason).toBe("no_current_estimate");
  });

  it("no samples at all: unknown", () => {
    expect(calmReading(NOW).state).toBe("unknown");
  });
});
