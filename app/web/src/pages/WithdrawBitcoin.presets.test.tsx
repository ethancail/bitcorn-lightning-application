// Drive-mode P1 item 7 (spec P1 item 7; D1.9): Withdraw offers no preset,
// default amount or Max that the policy would refuse. The ceiling is the
// server's /api/swaps/limits → loop_out.available_now_sats (the pre-quote
// policy's acceptance point); the floor is loop_out.min_sats.
//
// Harness: swapLimits.pages.test.tsx's.

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

const limits = (availableNow: number) => ({
  loop_available: true,
  loop_out: {
    min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
    available_now_sats: availableNow,
  },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 },
});

// The raw channel holds much more than available_now, so a page that derives
// its own ceiling from the channel offers presets the server would refuse.
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

const buttons = () => [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
const PRESET_LABELS = ["250k", "500k", "1M", "2M"];
const amountValue = () => (host.querySelector('input[inputmode="numeric"], input[type="text"]') as HTMLInputElement)?.value ?? "";

describe("D1.9 — no preset, default or Max beyond what is possible now", () => {
  it("700,000 possible: presets 250k and 500k only; Max is 700,000", async () => {
    await mount(700_000);
    const shown = buttons().filter((b) => PRESET_LABELS.includes(b));
    expect(shown).toEqual(["250k", "500k"]);
    const max = [...host.querySelectorAll("button")].find((b) => b.getAttribute("title") === "700,000 sats");
    expect(max, "a Max button worth exactly available_now").toBeDefined();
  });

  it("less than the minimum possible: no preset, no Max, no default amount, and Get Quote disabled", async () => {
    await mount(200_000);
    expect(buttons().filter((b) => PRESET_LABELS.includes(b))).toEqual([]);
    expect([...host.querySelectorAll("button")].some((b) => (b.getAttribute("title") ?? "").endsWith(" sats"))).toBe(false);
    expect(amountValue().replace(/[^0-9]/g, "")).toBe("");
    const getQuote = [...host.querySelectorAll("button")].find((b) => /Get Quote/.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(getQuote.disabled).toBe(true);
    expect(stub.getSwapLoopOutQuote).not.toHaveBeenCalled();
  });
});
