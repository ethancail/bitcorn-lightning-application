// Path C (C1 manual, C2 auto, C3 scheduler) — loop-fee-ceilings spec §4 C1–C3.
// All three reach loopd through executeLoopOut (C2 and C3 via
// autoLoopOutRebalance, which calls it with channel and amount only), so this
// one function-level file covers all three.
//
// Done-whens here: D1 for C (ceilings from the in-call quote), D4b (no ceiling
// overrides at the function level), D14 at the function level (conf_target is
// the default), D9 (the probe on path C) and D10 (the fee-rate check on path C).
//
// Same isolation as rebalance-loop.lossCap.test.ts: LND, loopd and the ledger
// writes are stubbed; the real executeLoopOut, the real pre-check module
// (loopOutPrechecks.ts) and the real loss-cap function run.

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "842391119757312";
const PAYMENT_DEST = "03" + "fb".repeat(32);

const s = vi.hoisted(() => ({
  quotes: [] as any[],
  probe: vi.fn(),
}));

function quote(minerFee = 1_000) {
  return {
    swap_fee_sat: 2_000,
    miner_fee: minerFee,
    total_cost_sats: 2_000 + 30_000 + minerFee,
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
// The real module underneath, so the real routingFeeCeilingSat (the 1% cap)
// is what the pre-checks apply; every loopd RPC is replaced.
vi.mock("./loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./loop")>()),
  isLoopAvailable: vi.fn(),
  getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
  // Each call takes the next queued quote; with none queued, a default one.
  getLoopOutQuote: vi.fn(async () => s.quotes.shift() ?? quote()),
  executeLoopOutSwap: vi.fn(async () => ({ id: "swap-1", swap_hash: "ab", server_message: "" })),
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

import { executeLoopOut, LoopOutError } from "./rebalance-loop";
import { createLndChainAddress } from "./lnd";
import { executeLoopOutSwap } from "./loop";
import { createRebalanceExecution } from "../api/treasury-rebalance-executions";

const AMOUNT = 500_000;

beforeEach(() => {
  vi.clearAllMocks();
  s.quotes = [];
  s.probe.mockResolvedValue({ routable: true, feeSat: 3 });
});

function sent() {
  expect(executeLoopOutSwap).toHaveBeenCalledTimes(1);
  return vi.mocked(executeLoopOutSwap).mock.calls[0][0];
}

function expectNoOutflow() {
  expect(createLndChainAddress).not.toHaveBeenCalled();
  expect(createRebalanceExecution).not.toHaveBeenCalled();
  expect(executeLoopOutSwap).not.toHaveBeenCalled();
}

describe("D1 (C): ceilings come from the in-call quote", () => {
  it("max_swap_fee is the quoted swap fee", async () => {
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(sent().max_swap_fee).toBe(2_000);
  });

  it("max_miner_fee is the quoted miner fee", async () => {
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(sent().max_miner_fee).toBe(1_000);
  });

  it("max_prepay_amt is the quoted prepay (already quote-bound before this arc)", async () => {
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(sent().max_prepay_amt).toBe(30_000);
  });
});

describe("D4b and D14 (function level): executeLoopOut takes no overrides", () => {
  it("oversized ceilings and a conf_target forced in anyway leave what is sent unchanged", async () => {
    // The fields are gone from the parameter type; force them in to prove
    // nothing still reads them.
    const forced = {
      channel_id: CHANNEL,
      amount_sats: AMOUNT,
      max_swap_fee_sats: 999_999,
      max_miner_fee_sats: 999_999,
      conf_target: 144,
    } as unknown as Parameters<typeof executeLoopOut>[0];
    await executeLoopOut(forced);
    expect(sent()).toMatchObject({ max_swap_fee: 2_000, max_miner_fee: 1_000, sweep_conf_target: 6 });
  });
});

describe("D9: the route probe on path C", () => {
  it("a probed route fee above the cap → LoopOutError route_fee_over_cap, no outflow", async () => {
    // 1% of 500,000 = 5,000.
    s.probe.mockImplementation(async (_d: string, amt: number) => ({ routable: true, feeSat: amt === AMOUNT ? 5_001 : 3 }));
    const err = await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LoopOutError);
    expect(err.code).toBe("route_fee_over_cap");
    expectNoOutflow();
  });

  it("probes over the swap's own channel, the quote's swap_payment_dest first", async () => {
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(s.probe.mock.calls[0]).toEqual([PAYMENT_DEST, AMOUNT, CHANNEL]);
    expect(s.probe.mock.calls[1]).toEqual([PAYMENT_DEST, 30_000, CHANNEL]);
  });

  it("neither the destination nor a Loop server routes → route_not_found, no outflow", async () => {
    s.probe.mockResolvedValue({ routable: false });
    const err = await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LoopOutError);
    expect(err.code).toBe("route_not_found");
    expectNoOutflow();
  });
});

describe("D10: the fee-rate refusal on path C", () => {
  it("a fresh miner fee above the in-call quote + 50% → fee_rate_over_quote, no outflow", async () => {
    s.quotes = [quote(1_000), quote(1_501)];
    const err = await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LoopOutError);
    expect(err.code).toBe("fee_rate_over_quote");
    expectNoOutflow();
  });

  it("exactly quote + 50% proceeds", async () => {
    s.quotes = [quote(1_000), quote(1_500)];
    await executeLoopOut({ channel_id: CHANNEL, amount_sats: AMOUNT });
    expect(executeLoopOutSwap).toHaveBeenCalledTimes(1);
  });
});
