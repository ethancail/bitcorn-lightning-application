// code-audit-2, Loop and money-path env parses (the F02 follow-up): the
// treasury rebalance path (path C: executeLoopOut, which C1–C3 all reach) has
// no ceiling echo, so its own checks are all that stand between a malformed
// env value and loopd. Before the fix:
//   LOOP_MAX_SWAP_FEE_PCT="abc" → NaN: `swap_fee > NaN` is false, the 15%
//     sanity check on the quote never refused;
//   LOOP_ROUTING_FEE_CAP_PPM="abc" → NaN: the probe passed any route, and the
//     LoopOut request carried NaN routing ceilings (0 on the wire).
// Each ⚠ case was red on that code.
//
// Isolation as rebalance-loop.ceilings.test.ts: LND, loopd and the ledger
// writes are stubbed; the real executeLoopOut and pre-check module run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "842391119757312";
const PAYMENT_DEST = "03" + "fb".repeat(32);
const AMOUNT = 500_000;

const s = vi.hoisted(() => ({
  quote: null as any,
  probe: vi.fn(),
  executeLoopOutSwap: vi.fn(),
  routingFeeCeilingSat: (_amountSat: number): number => {
    throw new Error("load() did not set routingFeeCeilingSat");
  },
}));

function quote(swapFee: number) {
  return {
    swap_fee_sat: swapFee,
    miner_fee: 1_000,
    total_cost_sats: swapFee + 30_000 + 1_000,
    prepay_amt_sat: 30_000,
    conf_target: 6,
    swap_payment_dest: PAYMENT_DEST,
  };
}

vi.mock("./lnd", () => ({
  getLndChannels: vi.fn(async () => ({
    channels: [{ id: CHANNEL, is_active: true, capacity: 2_000_000 }],
  })),
  createLndChainAddress: vi.fn(async () => ({ address: "bc1qtestonly" })),
  probeLoopOutPaymentRoute: s.probe,
}));
// The factory's importOriginal result is evaluated once and kept across
// vi.resetModules, so its ENV would be the FIRST case's (measured: the routing
// case passed on the unfixed code when run after the others, and failed run
// alone). routingFeeCeilingSat therefore delegates to a copy of the real
// module that load() imports fresh, under the case's own env.
vi.mock("./loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loop")>()),
  routingFeeCeilingSat: (amountSat: number) => s.routingFeeCeilingSat(amountSat),
  isLoopAvailable: vi.fn(),
  getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
  getLoopOutQuote: vi.fn(async () => s.quote),
  executeLoopOutSwap: s.executeLoopOutSwap,
  listLoopSwaps: vi.fn(),
}));
vi.mock("../api/treasury-liquidity-health", () => ({ getLiquidityHealth: vi.fn() }));
vi.mock("../api/treasury-rebalance-executions", () => ({
  createRebalanceExecution: vi.fn(() => 1),
  updateRebalanceExecution: vi.fn(),
  getRebalanceExecutions: vi.fn(),
}));
vi.mock("../api/treasury-rebalance-costs", () => ({ insertRebalanceCost: vi.fn() }));
vi.mock("../api/treasury-capital-policy", () => ({
  getCapitalPolicy: () => ({ max_daily_loss_sats: 10_000_000 }),
}));
vi.mock("../db", () => ({
  db: { prepare: () => ({ get: () => ({ v: 0 }) }) },
}));

const VARS = ["LOOP_MAX_SWAP_FEE_PCT", "LOOP_ROUTING_FEE_CAP_PPM"] as const;

beforeEach(() => {
  s.quote = quote(2_000);
  s.probe.mockReset();
  s.probe.mockResolvedValue({ routable: true, feeSat: 3 });
  s.executeLoopOutSwap.mockReset();
  s.executeLoopOutSwap.mockResolvedValue({ id: "swap-1", swap_hash: "ab", server_message: "" });
});

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  vi.restoreAllMocks();
});

async function load(env: Partial<Record<(typeof VARS)[number], string>>) {
  vi.resetModules();
  for (const v of VARS) {
    if (env[v] === undefined) delete process.env[v];
    else process.env[v] = env[v];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const actualLoop = await vi.importActual<typeof import("./loop")>("./loop");
  s.routingFeeCeilingSat = actualLoop.routingFeeCeilingSat;
  return import("./rebalance-loop");
}

describe("path C: LOOP_MAX_SWAP_FEE_PCT (default 15%)", () => {
  it("⚠ \"abc\": a 16% swap fee is refused before anything reaches loopd", async () => {
    const { executeLoopOut, LoopOutError } = await load({ LOOP_MAX_SWAP_FEE_PCT: "abc" });
    s.quote = quote(80_000); // 16% of 500,000
    const err = await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT }).catch((e) => e);
    expect(err).toBeInstanceOf(LoopOutError);
    expect(String(err.message)).toContain("exceeds max 75000");
    expect(s.executeLoopOutSwap).not.toHaveBeenCalled();
  });

  it("⚠ empty: a 1% swap fee goes through (the cap is the default, not 0)", async () => {
    const { executeLoopOut } = await load({ LOOP_MAX_SWAP_FEE_PCT: "" });
    s.quote = quote(5_000);
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(s.executeLoopOutSwap).toHaveBeenCalledTimes(1);
  });
});

describe("path C: LOOP_ROUTING_FEE_CAP_PPM (default 10,000 ppm)", () => {
  it("⚠ \"abc\": a probed route over 1% is refused before loopd (route_fee_over_cap)", async () => {
    const { executeLoopOut, LoopOutError } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "abc" });
    s.probe.mockImplementation(async (_pk: string, amt: number) => ({ routable: true, feeSat: amt === AMOUNT ? 5_001 : 1 }));
    const err = await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT }).catch((e) => e);
    expect(err).toBeInstanceOf(LoopOutError);
    expect(err.code).toBe("route_fee_over_cap");
    expect(s.executeLoopOutSwap).not.toHaveBeenCalled();
  });

  it("control: a configured 20,000 ppm lets the same route through, with 2% ceilings sent", async () => {
    const { executeLoopOut } = await load({ LOOP_ROUTING_FEE_CAP_PPM: "20000" });
    s.probe.mockImplementation(async (_pk: string, amt: number) => ({ routable: true, feeSat: amt === AMOUNT ? 5_001 : 1 }));
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(s.executeLoopOutSwap).toHaveBeenCalledTimes(1);
    expect(s.routingFeeCeilingSat(AMOUNT)).toBe(10_000);
  });
});
