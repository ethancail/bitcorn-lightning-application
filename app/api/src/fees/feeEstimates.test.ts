// fee-estimates — the API fee source (spec §4, §5, §11; §13 item 7).
//
// The pure function is driven with stubbed reads; every expected rate is
// derived from the stub's own figures through the ruled rule (P8), never typed
// as a literal that happens to match.

import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  FEE_RATE_CEILING_SAT_PER_VBYTE,
  OPTION_KEYS,
  SIZE_VB,
  WORKER_STALE_AFTER_MS,
  computeFeeEstimates,
  readFeeEstimates,
  toSendableRate,
  type LndRead,
  type WorkerRead,
} from "./feeEstimates";

// The Q3 capture the Worker's tests use (sha256 7f190af8…c74f7af0).
const FIXTURE: Array<{ medianFee: number }> = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../../../cloudflare-worker/tests/fixtures/mempool-blocks-20261117T182010Z.json"),
    "utf8",
  ),
);

const NOW = Date.parse("2026-11-18T12:00:00.000Z");

function workerFresh(blocks: unknown, ageMs = 60_000, header = "cache"): WorkerRead {
  return { ok: true, header, body: { fetched_at: new Date(NOW - ageMs).toISOString(), blocks } };
}

function lndAt(p: number | Error, n: number | Error, e: number | Error): LndRead {
  const one = (v: number | Error) =>
    v instanceof Error ? ({ ok: false, error: v.message } as const) : ({ ok: true, satPerVbyte: v } as const);
  return { 2: one(p), 3: one(n), 6: one(e) };
}

describe("P8 — toSendableRate: round up, except within 0.05 of an integer; minimum 1", () => {
  const CASES: Array<[number, number, string]> = [
    [1.012, 1, "LND's 253 sat/kw floor, within 0.05 of 1"],
    [1.302318061478143, 2, "the fixture's block 1: not within 0.05, rounds up"],
    [1.0053475935828877, 1, "within 0.05 of 1"],
    [0.12410272770776842, 1, "sub-1 figure lifted to the minimum"],
    [0.01, 1, "tiny figure lifted to the minimum"],
    [1.05, 1, "exactly 0.05 above: within (inclusive)"],
    [1.051, 2, "just past the tolerance rounds up"],
    [2.95, 3, "within 0.05 below rounds to that integer"],
    [2.94, 3, "otherwise rounds up"],
    [3, 3, "an integer stays"],
    [3.06, 4, "rounds up"],
    [25, 25, "25 is just a number here"],
    [199.97, 200, "near the ceiling"],
  ];
  for (const [input, want, why] of CASES) {
    it(`${input} → ${want} (${why})`, () => {
      expect(toSendableRate(input)).toBe(want);
    });
  }
});

describe("§13 item 7 — the source order", () => {
  it("Worker fresh → source worker, rates from blocks 1/3/6 (indexes 0, 2, 5), costs = rate × size", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(FIXTURE, 90_000), lnd: null });

    expect(out.source).toBe("worker");
    expect(out.worker_source).toBe("cache");
    expect(out.data_age_seconds).toBe(90);
    expect(out.unavailable_reason).toBeNull();
    const want = {
      priority: toSendableRate(FIXTURE[0].medianFee),
      normal: toSendableRate(FIXTURE[2].medianFee),
      economy: toSendableRate(FIXTURE[5].medianFee),
    };
    // R1's worked case in the fixture's conditions: Priority 2, Normal and Economy 1.
    expect(want).toEqual({ priority: 2, normal: 1, economy: 1 });
    for (const key of OPTION_KEYS) {
      const o = out.options![key];
      expect(o.rate).toBe(want[key]);
      expect(o.estimate).toBe(false);
      expect(o.target).toBeNull();
      expect(o.cost_sats).toEqual({ open: want[key] * SIZE_VB.open, close: want[key] * SIZE_VB.close });
    }
    expect([out.options!.priority.block, out.options!.normal.block, out.options!.economy.block]).toEqual([1, 3, 6]);
    expect(SIZE_VB).toEqual({ open: 155, close: 192 });
  });

  it("each option reads its own block: distinct medians land on the right option", () => {
    const blocks = [10.2, 9.3, 8.4, 7.5, 6.6, 5.7, 4.8].map((m) => ({ medianFee: m }));
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(blocks), lnd: null });
    expect(out.options!.priority.rate).toBe(toSendableRate(10.2));
    expect(out.options!.normal.rate).toBe(toSendableRate(8.4));
    expect(out.options!.economy.rate).toBe(toSendableRate(5.7));
  });

  it("Worker fresh and LND flat 25 → worker: the flat-25 check never fires with fresh Worker data", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(FIXTURE), lnd: lndAt(25, 25, 25) });
    expect(out.source).toBe("worker");
    expect(out.options!.economy.rate).toBe(toSendableRate(FIXTURE[5].medianFee));
  });

  it("Worker stale and LND normal → lnd, labelled estimate, targets 2/3/6", () => {
    const lnd = lndAt(14.6, 6.02, 1.012);
    const out = computeFeeEstimates({
      nowMs: NOW,
      worker: workerFresh(FIXTURE, WORKER_STALE_AFTER_MS + 1),
      lnd,
    });
    expect(out.source).toBe("lnd");
    expect(out.data_age_seconds).toBe(0);
    expect(out.options!.priority).toMatchObject({ rate: toSendableRate(14.6), target: 2, block: null, estimate: true });
    expect(out.options!.normal).toMatchObject({ rate: toSendableRate(6.02), target: 3, estimate: true });
    expect(out.options!.economy).toMatchObject({ rate: toSendableRate(1.012), target: 6, estimate: true });
  });

  it("Worker stale and LND flat 25 at every target → unavailable, no figure", () => {
    const out = computeFeeEstimates({
      nowMs: NOW,
      worker: workerFresh(FIXTURE, WORKER_STALE_AFTER_MS + 1),
      lnd: lndAt(25, 25, 25),
    });
    expect(out.source).toBe("unavailable");
    expect(out.unavailable_reason).toBe("lnd_flat_25");
    expect(out.options).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/"rate"/);
  });

  it("a 25 the check does not catch (not every target) is not treated specially", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: null, lnd: lndAt(25, 25, 3.3) });
    expect(out.source).toBe("lnd");
    expect(out.options!.priority.rate).toBe(25);
    expect(out.options!.economy.rate).toBe(toSendableRate(3.3));
  });

  it("P6 (a): Worker stale and an LND target errors → unavailable", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: null, lnd: lndAt(5, new Error("ETIMEDOUT"), 2) });
    expect(out.source).toBe("unavailable");
    expect(out.unavailable_reason).toBe("lnd_error");
    expect(out.options).toBeNull();
  });
});

describe("P10 — the Worker's data is stale after 30 min", () => {
  it("exactly 30 min old → still used", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(FIXTURE, WORKER_STALE_AFTER_MS), lnd: null });
    expect(out.source).toBe("worker");
    expect(out.data_age_seconds).toBe(1800);
  });
  it("30 min and 1 ms → not used", () => {
    const out = computeFeeEstimates({
      nowMs: NOW,
      worker: workerFresh(FIXTURE, WORKER_STALE_AFTER_MS + 1),
      lnd: lndAt(3, 2, 1),
    });
    expect(out.source).toBe("lnd");
  });
  it("the X-Fee-Source value does not decide freshness: 'fallback' data under 30 min is used", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(FIXTURE, 20 * 60_000, "fallback"), lnd: null });
    expect(out.source).toBe("worker");
    expect(out.worker_source).toBe("fallback");
  });
  it("'none' (no blocks) falls to LND, and the header is still reported", () => {
    const out = computeFeeEstimates({
      nowMs: NOW,
      worker: { ok: true, header: "none", body: { fetched_at: null, blocks: null } },
      lnd: lndAt(3, 2, 1),
    });
    expect(out.source).toBe("lnd");
    expect(out.worker_source).toBe("none");
  });
  it("an HTTP error from the Worker falls to LND", () => {
    const out = computeFeeEstimates({
      nowMs: NOW,
      worker: { ok: false, header: null, error: "http_502" },
      lnd: lndAt(3, 2, 1),
    });
    expect(out.source).toBe("lnd");
  });
});

describe("P9 — absent projected blocks", () => {
  it("zero blocks (F7): every option takes P8's minimum", () => {
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh([]), lnd: null });
    expect(out.source).toBe("worker");
    for (const key of OPTION_KEYS) expect(out.options![key].rate).toBe(toSendableRate(0));
    expect(toSendableRate(0)).toBe(1);
  });
  it("two blocks: Normal and Economy take the last present block's figure", () => {
    const blocks = [{ medianFee: 9.4 }, { medianFee: 4.2 }];
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(blocks), lnd: null });
    expect(out.options!.priority.rate).toBe(toSendableRate(9.4));
    expect(out.options!.normal.rate).toBe(toSendableRate(4.2));
    expect(out.options!.economy.rate).toBe(toSendableRate(4.2));
  });
  it("a used block with no valid medianFee makes the Worker data invalid (D5) → LND", () => {
    const blocks = FIXTURE.map((b) => ({ ...b }));
    (blocks[2] as any).medianFee = null;
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(blocks), lnd: lndAt(3, 2, 1) });
    expect(out.source).toBe("lnd");
  });
});

describe("the answer carries the ceiling (P15), unchanged by any rate", () => {
  it("a rate above 200 is still reported as is; the cards block it", () => {
    const blocks = [{ medianFee: 250.4 }];
    const out = computeFeeEstimates({ nowMs: NOW, worker: workerFresh(blocks), lnd: null });
    expect(out.ceiling_sat_per_vbyte).toBe(FEE_RATE_CEILING_SAT_PER_VBYTE);
    expect(FEE_RATE_CEILING_SAT_PER_VBYTE).toBe(200);
    expect(out.options!.priority.rate).toBe(toSendableRate(250.4));
  });
});

describe("readFeeEstimates — what gets read (P11, O1)", () => {
  const okFees = (body: unknown, header = "live") =>
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "X-Fee-Source": header } });

  it("not mainnet: the Worker is never asked, LND is read at 2/3/6", async () => {
    const fetchWorkerFees = vi.fn(okFees({ fetched_at: new Date(NOW).toISOString(), blocks: FIXTURE }));
    const getChainFeeRate = vi.fn(async (t: number) => ({ tokens_per_vbyte: t + 0.5 }));
    const out = await readFeeEstimates({ now: () => NOW, network: "regtest", fetchWorkerFees, getChainFeeRate });

    expect(fetchWorkerFees).not.toHaveBeenCalled();
    expect(getChainFeeRate.mock.calls.map((c) => c[0]).sort()).toEqual([2, 3, 6]);
    expect(out.source).toBe("lnd");
    expect(out.worker_source).toBeNull();
    expect(out.options!.priority.rate).toBe(toSendableRate(2.5));
  });

  it("mainnet with usable Worker data: LND is not read", async () => {
    const fetchWorkerFees = vi.fn(okFees({ fetched_at: new Date(NOW - 1000).toISOString(), blocks: FIXTURE }));
    const getChainFeeRate = vi.fn(async () => ({ tokens_per_vbyte: 9 }));
    const out = await readFeeEstimates({ now: () => NOW, network: "mainnet", fetchWorkerFees, getChainFeeRate });

    expect(getChainFeeRate).not.toHaveBeenCalled();
    expect(out.source).toBe("worker");
    expect(out.worker_source).toBe("live");
  });

  it("mainnet, Worker unreachable: LND is read; one target rejecting → unavailable (P6)", async () => {
    const fetchWorkerFees = vi.fn(async () => { throw new Error("transport_error"); });
    const getChainFeeRate = vi.fn(async (t: number) => {
      if (t === 3) throw new Error("ETIMEDOUT");
      return { tokens_per_vbyte: 4 };
    });
    const out = await readFeeEstimates({ now: () => NOW, network: "mainnet", fetchWorkerFees, getChainFeeRate });
    expect(out.source).toBe("unavailable");
    expect(out.unavailable_reason).toBe("lnd_error");
  });
});
