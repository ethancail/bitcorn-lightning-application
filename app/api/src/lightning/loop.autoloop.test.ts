// F8: autoloop is detected and switched off, whoever set it
// (loop-fee-ceilings spec §4 "Every site", F8; ruling (a); B11; B12; ruling 2).
//
// Done-whens: D6 (autoloop on → exactly one switch-off and a log line), D7
// (autoloop off → no call; a GUARD test — it passes on the pre-fix code by
// construction, so its proof is its control), D15 (a failed read or
// switch-off logs, lets the call proceed, and retries at the next connect),
// D17 (the set written back equals the set read, except autoloop=false).
//
// "Connect" is B11's: the first successful loopd call after the process
// starts, and every unavailable → available transition of isLoopAvailable().
// loop.ts keeps that state at module level, so each test loads a fresh copy
// (vi.resetModules + dynamic import); the transport double persists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Cb = (err: unknown, res?: unknown) => void;

const t = vi.hoisted(() => ({
  getInfo: (cb: (e: unknown, r?: unknown) => void) => cb(null, { version: "0.33.0-beta" }),
  getParams: (cb: (e: unknown, r?: unknown) => void) => cb(null, {}),
  setParams: (cb: (e: unknown, r?: unknown) => void) => cb(null, {}),
  setRequests: [] as any[],
  getCalls: 0,
}));

vi.mock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
vi.mock("@grpc/grpc-js", () => {
  class FakeSwapClient {
    GetInfo(_r: unknown, _o: unknown, cb: Cb) { t.getInfo(cb); }
    LoopOutTerms(_r: unknown, _o: unknown, cb: Cb) { cb(null, { min_swap_amount: 250_000, max_swap_amount: 5_000_000 }); }
    GetLiquidityParams(_r: unknown, _o: unknown, cb: Cb) { t.getCalls++; t.getParams(cb); }
    SetLiquidityParams(req: unknown, _o: unknown, cb: Cb) { t.setRequests.push(req); t.setParams(cb); }
  }
  return {
    loadPackageDefinition: () => ({ looprpc: { SwapClient: FakeSwapClient } }),
    credentials: {
      createSsl: () => ({}),
      createFromMetadataGenerator: () => ({}),
      combineChannelCredentials: () => ({}),
    },
    Metadata: class { add() {} },
  };
});
const present = vi.hoisted(() => ({ files: true }));
vi.mock("fs", () => {
  const existsSync = () => present.files;
  const readFileSync = () => Buffer.from("stub");
  return { default: { existsSync, readFileSync }, existsSync, readFileSync };
});

/** A full parameter set, as GetLiquidityParams returns one (proto-loader
 *  with defaults: true fills every field), autoloop on. */
function paramsRead(autoloop: boolean) {
  return {
    rules: [],
    fee_ppm: "0",
    sweep_fee_rate_sat_per_vbyte: "25",
    max_swap_fee_ppm: "5000",
    max_routing_fee_ppm: "10000",
    max_prepay_routing_fee_ppm: "5000",
    max_prepay_sat: "30000",
    max_miner_fee_sat: "15000",
    sweep_conf_target: 100,
    failure_backoff_sec: "86400",
    autoloop,
    autoloop_budget_sat: "1000000",
    autoloop_budget_start_sec: "0",
    auto_max_in_flight: "1",
    min_swap_amount: "250000",
    max_swap_amount: "5000000",
    htlc_conf_target: 6,
    autoloop_dest_address: "",
    autoloop_budget_refresh_period_sec: "604800",
    autoloop_budget_last_refresh: "0",
    easy_autoloop: false,
    easy_autoloop_local_target_sat: "0",
    account: "",
    account_addr_type: "ADDRESS_TYPE_UNKNOWN",
    easy_asset_params: {},
    fast_swap_publication: true,
    easy_autoloop_excluded_peers: [],
  };
}

type Loop = typeof import("./loop");
let loop: Loop;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  present.files = true;
  t.getInfo = (cb) => cb(null, { version: "0.33.0-beta" });
  t.getParams = (cb) => cb(null, paramsRead(false));
  t.setParams = (cb) => cb(null, {});
  t.setRequests = [];
  t.getCalls = 0;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  loop = await import("./loop");
});

afterEach(() => {
  log.mockRestore();
  err.mockRestore();
});

/** Wait for any autoloop check in flight. Tolerates the seam's absence, so
 *  against pre-fix code these tests fail on behaviour, not on a missing export. */
async function settled() {
  await ((loop as any).whenAutoloopCheckSettles?.() ?? Promise.resolve());
}

/** Drive one B11 "connect" point and wait for the check it starts. */
async function connect() {
  const r = await loop.isLoopAvailable();
  await settled();
  return r;
}

const switchOffLines = () =>
  log.mock.calls.filter((c) => String(c[0]).includes("autoloop was on")).length;

describe("D6: autoloop on → exactly one switch-off and a log line", () => {
  it("one SetLiquidityParams with autoloop=false, and one log line", async () => {
    t.getParams = (cb) => cb(null, paramsRead(true));
    await connect();
    expect(t.setRequests).toHaveLength(1);
    expect(t.setRequests[0].parameters.autoloop).toBe(false);
    expect(switchOffLines()).toBe(1);
  });

  it("further successful calls with no unavailable spell between them do not re-check", async () => {
    t.getParams = (cb) => cb(null, paramsRead(true));
    await connect();
    await connect();
    await loop.getLoopOutTerms();
    await settled();
    expect(t.getCalls).toBe(1);
    expect(t.setRequests).toHaveLength(1);
  });
});

describe("D7 (guard): autoloop off → no switch-off call", () => {
  it("writes nothing and logs no switch-off", async () => {
    await connect();
    expect(t.setRequests).toHaveLength(0);
    expect(switchOffLines()).toBe(0);
  });
});

describe("D17: the set written back equals the set read, except autoloop=false", () => {
  it("every field round-trips, fields 25–27 included", async () => {
    t.getParams = (cb) => cb(null, paramsRead(true));
    await connect();
    expect(t.setRequests[0].parameters).toEqual({ ...paramsRead(true), autoloop: false });
  });
});

describe("B11: when the check runs", () => {
  it("the first connect reads the parameters, with autoloop off too", async () => {
    await connect();
    expect(t.getCalls).toBe(1);
  });

  it("the first successful loopd call of any kind triggers it", async () => {
    t.getParams = (cb) => cb(null, paramsRead(true));
    await loop.getLoopOutTerms();
    await settled();
    expect(t.setRequests).toHaveLength(1);
  });

  it("an unavailable → available transition triggers it again", async () => {
    await connect(); // first check: autoloop off
    t.getInfo = (cb) => cb({ code: 14, details: "connection refused" });
    expect((await connect()).available).toBe(false);
    // Someone turned autoloop on while loopd was away.
    t.getParams = (cb) => cb(null, paramsRead(true));
    t.getInfo = (cb) => cb(null, { version: "0.33.0-beta" });
    await connect();
    expect(t.getCalls).toBe(2);
    expect(t.setRequests).toHaveLength(1);
  });
});

describe("D15: a failed read or switch-off logs, lets the call proceed, and retries at the next connect", () => {
  it("a failed read: logged, the triggering call still answers available, retried after the next transition", async () => {
    t.getParams = (cb) => cb({ code: 2, details: "boom" });
    const r = await connect();
    expect(r.available).toBe(true);
    expect(err.mock.calls.some((c) => String(c[0]).includes("autoloop check failed"))).toBe(true);
    expect(t.setRequests).toHaveLength(0);

    t.getInfo = (cb) => cb({ code: 14, details: "connection refused" });
    await connect();
    t.getInfo = (cb) => cb(null, { version: "0.33.0-beta" });
    t.getParams = (cb) => cb(null, paramsRead(true));
    await connect();
    expect(t.setRequests).toHaveLength(1);
    expect(t.setRequests[0].parameters.autoloop).toBe(false);
  });

  it("a failed switch-off: logged, the call still answers available", async () => {
    t.getParams = (cb) => cb(null, paramsRead(true));
    t.setParams = (cb) => cb({ code: 2, details: "invalid parameters" });
    const r = await connect();
    expect(r.available).toBe(true);
    expect(err.mock.calls.some((c) => String(c[0]).includes("autoloop check failed"))).toBe(true);
  });
});
