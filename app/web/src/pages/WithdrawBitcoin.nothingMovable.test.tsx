// Drive-mode P3, item 5 (BACKLOG §2, owned by drive-mode; gate 2 on Karan's
// farmer node): when nothing can move, Withdraw shows no amount input, no
// "250,000" placeholder, no presets and no "After withdrawal: 14% → 14%" line —
// one honest sentence instead. While the connection to Bitcorn is down, that
// sentence is the connection-down one (P2's), not a balance complaint. The
// copy says "connection", never "channel".
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

const ALWAYS_STAYS = { total_sats: 60_000, reserve_sats: 3_500, fee_headroom_sats: 6_500, swap_buffer_sats: 50_000 };

const limits = (o: { availableNow: number; dailyRemaining?: number; alwaysStays?: typeof ALWAYS_STAYS | null }) => ({
  loop_available: true,
  loop_out: {
    min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000,
    daily_remaining_sats: o.dailyRemaining ?? 5_000_000,
    available_now_sats: o.availableNow,
    always_stays: o.alwaysStays === undefined ? ALWAYS_STAYS : o.alwaysStays,
  },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 },
});

const stats = (isActive: boolean) => ({
  treasury_channel: {
    channel_id: "1", local_sats: 100_000, remote_sats: 230_000, capacity_sats: 350_000, is_active: isActive,
    room_to_send_sats: 96_500, room_to_receive_sats: 226_500, local_reserve_sats: 3_500, remote_reserve_sats: 3_500,
    pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 1_532,
    freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
  },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
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

async function mount(s: ReturnType<typeof stats>, l: ReturnType<typeof limits>) {
  stub.getMemberStats.mockResolvedValue(s);
  stub.getSwapLimits.mockResolvedValue(l);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(WithdrawBitcoin))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const amountInput = () => host.querySelector('input[aria-label="Amount"]');

const CONNECTION_DOWN = "Your connection to Bitcorn is down, so payments can't go through it right now.";

describe("P3 — Withdraw when nothing can move", () => {
  it("connected, too little waiting: no input, no placeholder, no after-line; the honest sentence names the trigger", async () => {
    await mount(stats(true), limits({ availableNow: 36_500 }));
    expect(amountInput()).toBeNull();
    expect(host.innerHTML).not.toContain('placeholder="250,000"');
    expect(text()).not.toContain("After withdrawal");
    // 250,000 minimum + 60,000 that always stays = 310,000 waiting.
    expect(text()).toContain("You can move 250,000 sats once 310,000 sats is waiting in your connection.");
  });

  it("disconnected: the connection-down sentence, not a balance complaint", async () => {
    await mount(stats(false), limits({ availableNow: 0, alwaysStays: null }));
    expect(amountInput()).toBeNull();
    expect(text()).toContain(CONNECTION_DOWN);
    expect(text()).not.toContain("Not enough in your");
    expect(text()).not.toContain("You can move");
  });

  it("today's limit used up: says so, and names no balance trigger", async () => {
    await mount(stats(true), limits({ availableNow: 100_000, dailyRemaining: 100_000 }));
    expect(amountInput()).toBeNull();
    expect(text()).toContain("You've withdrawn as much as the daily limit allows. It frees up over the next 24 hours.");
    expect(text()).not.toContain("You can move");
  });

  it("no message says 'channel'", async () => {
    await mount(stats(true), limits({ availableNow: 36_500, alwaysStays: null }));
    expect(text()).toContain("Not enough in your connection to withdraw right now");
    expect(text()).not.toMatch(/in your channel/i);
  });

  it("something can move: the amount input is back", async () => {
    await mount(stats(true), limits({ availableNow: 700_000 }));
    expect(amountInput()).not.toBeNull();
  });
});
