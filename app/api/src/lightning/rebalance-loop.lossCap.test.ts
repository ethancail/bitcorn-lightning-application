// LOSS-CAP PIN — treasury Loop Out must hit the daily loss cap BEFORE any
// outflow.
//
// executeLoopOut() calls assertDailyLossCapNotExceeded(quote.total_cost_sats)
// after quoting and before it generates an address, opens an execution record
// or calls loopd. Until this file, nothing in the suite noticed if that call
// went away: mutating it out left all 1404 API tests green.
//
// The REAL loss-cap function runs here. Only its inputs are stubbed — the
// capital policy (the cap) and the db row it sums (today's spend) — along with
// LND, loopd and the ledger writes. No LND, no loopd, no database.
//
// The numbers are chosen so the test also pins WHAT is passed: today's spend
// (8,000) plus the quoted cost (3,000) crosses the cap (10,000), but today's
// spend alone does not. A call that passed 0, or nothing, would admit the swap.

import { beforeEach, describe, expect, it, vi } from "vitest";

const CAP = 10_000;
const s = vi.hoisted(() => ({ dailyLossSats: 0 }));

vi.mock("./lnd", () => ({
  getLndChannels: vi.fn(async () => ({
    channels: [{ id: "842391119757312", is_active: true, capacity: 2_000_000 }],
  })),
  createLndChainAddress: vi.fn(async () => ({ address: "bc1qtestonly" })),
}));
vi.mock("./loop", () => ({
  isLoopAvailable: vi.fn(),
  getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
  getLoopOutQuote: vi.fn(async () => ({
    swap_fee_sat: 2_000,
    miner_fee: 1_000,
    total_cost_sats: 3_000,
    prepay_amt_sat: 30_000,
  })),
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
// The two inputs of the real assertDailyLossCapNotExceeded:
vi.mock("../api/treasury-capital-policy", () => ({
  getCapitalPolicy: () => ({ max_daily_loss_sats: CAP }),
}));
vi.mock("../db", () => ({
  db: { prepare: () => ({ get: () => ({ v: s.dailyLossSats }) }) },
}));

import { executeLoopOut } from "./rebalance-loop";
import { DailyLossCapError } from "../utils/loss-cap";
import { createLndChainAddress } from "./lnd";
import { executeLoopOutSwap, getLoopOutQuote } from "./loop";
import { createRebalanceExecution } from "../api/treasury-rebalance-executions";

const request = {
  channel_id: "842391119757312",
  amount_sats: 500_000,
  max_swap_fee_sats: 5_000,
  max_miner_fee_sats: 5_000,
  conf_target: 6,
};

beforeEach(() => {
  vi.clearAllMocks();
  s.dailyLossSats = 0;
});

describe("treasury Loop Out: the daily loss cap binds before any outflow", () => {
  it("refuses a swap whose quoted cost would cross the cap, before any outflow — and admits one within it", async () => {
    // ANTI-VACUITY FIRST: within the cap, the same request is admitted and
    // reaches the swap. Without this half, a fixture that refused everything
    // would satisfy the refusal below.
    s.dailyLossSats = 0;
    const admitted = await executeLoopOut(request);
    expect(admitted.ok, "a swap within the cap must be admitted").toBe(true);
    expect(executeLoopOutSwap).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // 8,000 already spent + 3,000 quoted >= 10,000 cap.
    s.dailyLossSats = 8_000;
    const refused = await executeLoopOut(request).then(
      () => null,
      (e) => e
    );
    expect(refused, "a swap that would cross the daily loss cap must be refused").toBeInstanceOf(DailyLossCapError);
    // It got as far as quoting — so the refusal is the cap, not an earlier check…
    expect(getLoopOutQuote).toHaveBeenCalledTimes(1);
    // …and nothing after the cap ran: no address, no execution record, no swap.
    expect(createLndChainAddress).not.toHaveBeenCalled();
    expect(createRebalanceExecution).not.toHaveBeenCalled();
    expect(executeLoopOutSwap).not.toHaveBeenCalled();
  });
});
