// drive-mode P2 item 6 (D2.3) on Withdraw and Top Up: each page shows the
// API's Loop alert for its own direction — Withdraw the loop_out one, Top Up
// the loop_in one — as one sentence and one action, and nothing when that
// direction is available. The sentence is the API's (rendered server-side,
// 2026-09-02 D2(b)); the page shows it verbatim and never reads the reason.
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
  getNodeBalances: vi.fn(),
  getSwapHistory: vi.fn(),
  getNodeAddress: vi.fn(),
  getSwapLimits: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./RefillChannel";
import WithdrawBitcoin from "./WithdrawBitcoin";

const LIMITS = {
  loop_available: true,
  loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 1_000_000 },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, onchain_rule: null, onchain_floor_sats: null, available_now_sats: null },
};

const channel = {
  channel_id: "1", local_sats: 1_500_000, remote_sats: 2_500_000, capacity_sats: 4_000_000, is_active: true,
  room_to_send_sats: 1_460_000, room_to_receive_sats: 2_460_000,
  local_reserve_sats: 40_000, remote_reserve_sats: 40_000, pending_outgoing_sats: 0, pending_incoming_sats: 0,
  commit_fee_sats: null, freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
};

// The API's sentences (app/api/src/memberAdvisor/loopAlert.ts), as it sends them.
const OUT = { text: "Loop isn't responding right now, so Withdraw isn't available.", action: { label: "Check again" } };
const IN = { text: "Top Up is currently unavailable.", action: { label: "Try again" } };

const advisor = (loopAlert: unknown) => ({
  channelRole: "farmer",
  classification: null,
  recommendation: null,
  loopAvailability: { loopDaemonRunning: true, loopOutAvailable: true, loopInAvailable: true, loopOutTerms: null, loopInTerms: null },
  loopAlert,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({ treasury_channel: channel });
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 10_000_000, lightning_sats: 1_500_000, total_sats: 11_500_000 });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  stub.getSwapLimits.mockResolvedValue(LIMITS);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(C: React.ComponentType) {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(C))); });
  await flush();
}

const alertWith = (phrase: string) =>
  [...host.querySelectorAll(".alert")].find((a) => a.textContent?.includes(phrase)) ?? null;

describe("Withdraw shows the loop_out alert", () => {
  it("one sentence and its action; the loop_in alert is not shown", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: OUT, loop_in: IN }));
    await mount(WithdrawBitcoin);
    const a = alertWith("Loop isn't responding")!;
    expect(a).not.toBeNull();
    expect(a.querySelector(".alert-msg")!.textContent).toBe(OUT.text);
    expect(a.querySelector("button")!.textContent).toBe("Check again");
    expect(alertWith("Top Up is currently unavailable")).toBeNull();
  });

  it("its action re-reads the status, and the alert clears when Loop is back", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: OUT, loop_in: null }));
    await mount(WithdrawBitcoin);
    const before = stub.getMemberLiquidityStatus.mock.calls.length;
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: null, loop_in: null }));
    await act(async () => { alertWith("Loop isn't responding")!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(stub.getMemberLiquidityStatus.mock.calls.length).toBe(before + 1);
    expect(alertWith("Loop isn't responding")).toBeNull();
  });

  it("available: no alert", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: null, loop_in: null }));
    await mount(WithdrawBitcoin);
    expect(alertWith("Loop")).toBeNull();
  });
});

describe("Top Up shows the loop_in alert", () => {
  it("one sentence and its action; the loop_out alert is not shown", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: OUT, loop_in: IN }));
    await mount(RefillChannel);
    const a = alertWith("Top Up is currently unavailable")!;
    expect(a).not.toBeNull();
    expect(a.querySelector(".alert-msg")!.textContent).toBe(IN.text);
    expect(a.querySelector("button")!.textContent).toBe("Try again");
    expect(alertWith("Loop isn't responding")).toBeNull();
  });

  it("its action re-reads the status", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: null, loop_in: IN }));
    await mount(RefillChannel);
    const before = stub.getMemberLiquidityStatus.mock.calls.length;
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: null, loop_in: null }));
    await act(async () => { alertWith("Top Up is currently unavailable")!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(stub.getMemberLiquidityStatus.mock.calls.length).toBe(before + 1);
    expect(alertWith("Top Up is currently unavailable")).toBeNull();
  });

  it("available: no alert", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(advisor({ loop_out: null, loop_in: null }));
    await mount(RefillChannel);
    expect(alertWith("currently unavailable")).toBeNull();
  });
});
