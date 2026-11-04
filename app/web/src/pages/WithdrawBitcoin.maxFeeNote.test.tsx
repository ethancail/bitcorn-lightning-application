// R25 (drive-mode P1, Withdraw edge, option (c)): the maximum Withdraw offers
// is available_now_sats, the pre-quote acceptance point. The swap's fees are
// not in it, so a withdrawal of exactly that amount is refused once the quote
// prices the fee. The gap is kept and said on the page: whenever a maximum is
// shown, one sentence under the Max control says the fees come out of it and
// the exact amount is set by the quote. (The quote-based maximum is P3.)
//
// Harness: WithdrawBitcoin.presets.test.tsx's.

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
  getSwapLimits: vi.fn(),
  getSwapLoopOutQuote: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import WithdrawBitcoin from "./WithdrawBitcoin";

const SENTENCE = "The swap's fees come out of this, so the exact amount you can withdraw is set when you get a quote.";

const limits = (availableNow: number) => ({
  loop_available: true,
  loop_out: {
    min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
    available_now_sats: availableNow,
  },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 },
});

const STATS = {
  treasury_channel: {
    channel_id: "1", local_sats: 3_000_000, remote_sats: 900_000, capacity_sats: 4_000_000, is_active: true,
    room_to_send_sats: 2_960_000, room_to_receive_sats: 860_000, local_reserve_sats: 40_000, remote_reserve_sats: 40_000,
    pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: null,
    freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue(STATS);
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount(availableNow: number) {
  stub.getSwapLimits.mockResolvedValue(limits(availableNow));
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(WithdrawBitcoin))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const maxButton = () => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Max");
const text = () => host.textContent ?? "";

describe("R25 — whenever a maximum is shown, the page says the fees come out of it", () => {
  for (const availableNow of [250_000, 700_000, 2_000_000]) {
    it(`maximum ${availableNow.toLocaleString()}: Max shown, and the sentence with it`, async () => {
      await mount(availableNow);
      expect(maxButton(), "a maximum is shown").toBeDefined();
      expect(text()).toContain(SENTENCE);
    });
  }

  it("no maximum (less than the minimum possible): no Max, no sentence", async () => {
    await mount(200_000);
    expect(maxButton()).toBeUndefined();
    expect(text()).not.toContain(SENTENCE);
  });
});
