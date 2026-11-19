// Drive-mode P1 item 7 (spec P1 item 7; D1.9): Withdraw offers no preset,
// default amount or maximum that the policy would refuse. The ceiling is the
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
// Slice 3: the presets are Choice radios keyed by sats (dollars over sats).
const presetValues = () => [...host.querySelectorAll('.withdraw-presets input[type="radio"]')].map((r) => (r as HTMLInputElement).value);
const amountValue = () => (host.querySelector('input[aria-label="Amount"]') as HTMLInputElement | null)?.value ?? "";
const upTo = () => host.querySelector("[data-testid='withdraw-answer'] [data-sats]")?.getAttribute("data-sats") ?? null;

// Re-pinned for member-first-run-ui slice 3 (Ethan's "recs", 2026-11-17): R5
// drops the Max button; the maximum is "You can withdraw up to", and "Withdraw
// the most now" sets it. R7 hides the presets, box and button below the minimum.
describe("D1.9 — no preset, default or maximum beyond what is possible now", () => {
  it("700,000 possible: presets 250,000 and 500,000 only; the most is 700,000", async () => {
    await mount(700_000);
    expect(presetValues()).toEqual(["250000", "500000"]);
    expect(upTo(), "the big amount is exactly available_now").toBe("700000");
    expect(buttons()).not.toContain("Max");
  });

  it("less than the minimum possible: no preset, no maximum, no default amount, and no Review button", async () => {
    await mount(200_000);
    expect(presetValues()).toEqual([]);
    expect(upTo()).toBeNull();
    expect(buttons()).not.toContain("Use the most");
    expect(amountValue().replace(/[^0-9]/g, "")).toBe("");
    expect(buttons().some((b) => /Review withdrawal|Get Quote/.test(b))).toBe(false);
    expect(stub.getSwapLoopOutQuote).not.toHaveBeenCalled();
  });
});
