// Drive-mode P3, plan item 4 (the cards): Withdraw's and Top Up's option cards.
//   D3.3  exactly one card is recommended; Top Up shows two cards
//   R25   Withdraw's Max is the quote-based maximum; "Checking today's fees…"
//         while the quote is out; with loopd unable to quote, available_now
//         and the original sentence
//   fee limit — a card over it says so, and its button waits for a one-off
//         "Allow it this once" (UI only)
//   D3.2  a card starts nothing: "Use …" pre-fills the amount; no quote,
//         no execute
//
// Harness: WithdrawBitcoin.presets.test.tsx's, with transfersApi stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getSwapHistory: vi.fn(),
  getNodeAddress: vi.fn(),
  getNodeBalances: vi.fn(),
  getSwapLimits: vi.fn(),
  getSwapLoopOutQuote: vi.fn(),
  getSwapLoopInQuote: vi.fn(),
  initiateSwapLoopOut: vi.fn(),
  initiateSwapLoopIn: vi.fn(),
  getSwapOptions: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const { getSwapOptions, ...rest } = stub;
  return {
    ...actual,
    api: { ...(actual as any).api, ...rest },
    transfersApi: { ...(actual as any).transfersApi, getSwapOptions },
  };
});

import WithdrawBitcoin from "./WithdrawBitcoin";
import RefillChannel from "./RefillChannel";

const CHANNEL = {
  channel_id: "1", local_sats: 600_000, remote_sats: 390_000, capacity_sats: 1_000_000, is_active: true,
  room_to_send_sats: 590_000, room_to_receive_sats: 380_000, local_reserve_sats: 10_000, remote_reserve_sats: 10_000,
  pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 872,
  freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
};

const LIMITS = {
  loop_available: true,
  loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 540_000, always_stays: null },
  loop_in: {
    min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
    onchain_rule: null, onchain_floor_sats: 162_210, available_now_sats: 900_000,
  },
};

const OUT = (o: { overLimit?: boolean; quote?: "ok" | "unavailable" } = {}) => ({
  direction: "loop_out", state: "ok", strategy: "save", floor_sats: 70_000, room_sats: 380_000, calm: "unknown",
  min_sats: 250_000, trigger_sats: null, quote_state: o.quote ?? "ok", reason: "bigger_share",
  cards: [
    { key: "now", amount_sats: o.quote === "unavailable" ? 540_000 : 531_600, fee_sats: o.quote === "unavailable" ? null : 8_316, over_fee_limit: !!o.overLimit, recommended: false },
    { key: "wait_bigger", amount_sats: 850_000, fee_sats: null, over_fee_limit: false, recommended: true },
  ],
});

const IN = {
  direction: "loop_in", state: "ok", strategy: "save", floor_sats: 200_000, room_sats: 140_000, calm: "unknown",
  min_sats: 100_000, trigger_sats: null, quote_state: "ok", reason: "room_low",
  cards: [
    { key: "now", amount_sats: 260_000, fee_sats: 3_300, over_fee_limit: false, recommended: true },
    { key: "wait_lower", amount_sats: null, fee_sats: null, over_fee_limit: false, recommended: false },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({ treasury_channel: CHANNEL });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 100_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 1_000_000, lightning_sats: 600_000, total_sats: 1_600_000 });
  stub.getSwapLimits.mockResolvedValue(LIMITS);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
const amountValue = () => (host.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null)?.value.replace(/[^0-9]/g, "") ?? "";
const recommendedCards = () => [...host.querySelectorAll('[data-recommended="true"]')].map((c) => c.getAttribute("data-testid"));

async function mount(C: React.ComponentType) {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(C))); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("Withdraw's cards", () => {
  it("two cards, exactly one recommended, with its reason", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT());
    await mount(WithdrawBitcoin);
    expect(host.querySelectorAll('[data-testid^="option-card-"]').length).toBe(2);
    expect(recommendedCards()).toEqual(["option-card-wait_bigger"]);
    expect(host.querySelectorAll('[data-testid="recommended-badge"]').length).toBe(1);
    expect(host.querySelector('[data-testid="recommended-reason"]')?.textContent).toBe("A later, bigger transfer costs a smaller share.");
    expect(text()).toContain("Move it all now");
    expect(text()).toContain("Wait for a bigger transfer");
  });

  it("'Use the most' pre-fills the quote-based Max and starts nothing", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT());
    await mount(WithdrawBitcoin);
    await act(async () => { button("Use the most")!.click(); });
    expect(amountValue()).toBe("531600");
    expect(stub.getSwapLoopOutQuote).not.toHaveBeenCalled();
    expect(stub.initiateSwapLoopOut).not.toHaveBeenCalled();
    expect(stub.initiateSwapLoopIn).not.toHaveBeenCalled();
  });

  it("R25: Max is the quote-based maximum, with the revised sentence", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT());
    await mount(WithdrawBitcoin);
    const max = [...host.querySelectorAll("button")].find((b) => b.textContent === "Max")!;
    expect(max.getAttribute("title")).toBe("531,600 sats");
    expect(host.querySelector('[data-testid="max-fee-note"]')?.textContent)
      .toBe("This allows for today's fees; if they rise before you confirm, the quote will say so.");
  });

  it("R25: loopd can't quote — Max falls back to today's figure and keeps the original sentence", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ quote: "unavailable" }));
    await mount(WithdrawBitcoin);
    const max = [...host.querySelectorAll("button")].find((b) => b.textContent === "Max")!;
    expect(max.getAttribute("title")).toBe("540,000 sats");
    expect(host.querySelector('[data-testid="max-fee-note"]')?.textContent)
      .toBe("The swap's fees come out of this, so the exact amount you can withdraw is set when you get a quote.");
  });

  it("before the quote arrives: 'Checking today's fees…' and no Max yet", async () => {
    stub.getSwapOptions.mockImplementation(() => new Promise(() => {}));
    await mount(WithdrawBitcoin);
    expect(text()).toContain("Checking today's fees…");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Max")).toBe(false);
  });

  it("over the fee limit: says so, and 'Use the most' waits for 'Allow it this once'", async () => {
    stub.getSwapOptions.mockResolvedValue(OUT({ overLimit: true }));
    await mount(WithdrawBitcoin);
    expect(host.querySelector('[data-testid="over-limit"]')?.textContent).toBe("That's over your fee limit, so you'd allow it once.");
    expect(button("Use the most")!.disabled).toBe(true);
    const tick = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { tick.click(); });
    expect(button("Use the most")!.disabled).toBe(false);
  });

  it("no cards when nothing can move", async () => {
    stub.getSwapOptions.mockResolvedValue({ ...OUT(), state: "nothing_movable", cards: [] });
    stub.getSwapLimits.mockResolvedValue({ ...LIMITS, loop_out: { ...LIMITS.loop_out, available_now_sats: 100_000 } });
    await mount(WithdrawBitcoin);
    expect(host.querySelector('[data-testid="option-cards"]')).toBeNull();
  });
});

describe("Top Up's cards", () => {
  it("two cards, exactly one recommended", async () => {
    stub.getSwapOptions.mockResolvedValue(IN);
    await mount(RefillChannel);
    expect(host.querySelectorAll('[data-testid^="option-card-"]').length).toBe(2);
    expect(recommendedCards()).toEqual(["option-card-now"]);
    expect(text()).toContain("Top up now");
    expect(text()).toContain("Wait until room to send is lower");
    expect(host.querySelector('[data-testid="recommended-reason"]')?.textContent).toBe("Room to send is already low.");
  });

  it("'Use this amount' pre-fills 260,000 and starts nothing", async () => {
    stub.getSwapOptions.mockResolvedValue(IN);
    await mount(RefillChannel);
    await act(async () => { button("Use this amount")!.click(); });
    expect(amountValue()).toBe("260000");
    expect(stub.getSwapLoopInQuote).not.toHaveBeenCalled();
    expect(stub.initiateSwapLoopOut).not.toHaveBeenCalled();
    expect(stub.initiateSwapLoopIn).not.toHaveBeenCalled();
  });

  it("wallet too low: Deposit bitcoin first + Wait", async () => {
    stub.getSwapOptions.mockResolvedValue({
      ...IN, reason: "wallet_low",
      cards: [
        { key: "deposit_first", amount_sats: null, fee_sats: null, over_fee_limit: false, recommended: true },
        { key: "wait", amount_sats: null, fee_sats: null, over_fee_limit: false, recommended: false },
      ],
    });
    await mount(RefillChannel);
    expect(text()).toContain("Deposit bitcoin first");
    expect(button("Deposit Bitcoin")).toBeDefined();
    expect(recommendedCards()).toEqual(["option-card-deposit_first"]);
  });

  it("no 'refuel' on either page's cards", async () => {
    stub.getSwapOptions.mockResolvedValue(IN);
    await mount(RefillChannel);
    expect(text()).not.toMatch(/refuel/i);
  });
});
