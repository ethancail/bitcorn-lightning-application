// Drive-mode P1 item 6 (spec P1 item 6; D1.8): Withdraw, Top Up and the farmer
// dashboard read the effective swap limits from GET /api/swaps/limits instead
// of hard-coding 250,000 / 2,000,000 / 100,000 / 3,000,000. Here loopd's terms
// are stricter than the env limits on every bound, so a page still using a
// literal shows the wrong figure.
//
// Harness: capacityText.guard.test.tsx's.

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

// Stricter than env on every bound (env: out 250k–2M, in 100k–3M).
const LIMITS = {
  loop_available: true,
  // available_now_sats: the server always sends it (P1 item 7). Without it the
  // page has nothing it can move, and since drive-mode P3 shows no amount
  // input then — so the below-minimum case needs a withdrawable amount.
  loop_out: { min_sats: 300_000, max_sats: 1_500_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 1_500_000 },
  loop_in: { min_sats: 150_000, max_sats: 2_500_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000 },
};

const channel = (local: number) => ({
  channel_id: "1", local_sats: local, remote_sats: 4_000_000 - local, capacity_sats: 4_000_000, is_active: true,
  room_to_send_sats: local - 40_000, room_to_receive_sats: 4_000_000 - local - 40_000,
  local_reserve_sats: 40_000, remote_reserve_sats: 40_000, pending_outgoing_sats: 0, pending_incoming_sats: 0,
  commit_fee_sats: null, freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 10_000_000, lightning_sats: 0, total_sats: 10_000_000 });
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

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

async function mount(C: React.ComponentType) {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(C))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function typeAmount(value: string) {
  const input = host.querySelector('input[inputmode="numeric"], input[type="text"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("D1.8 — Withdraw shows loopd's figures when they are stricter", () => {
  beforeEach(() => stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(3_000_000) }));

  it("the stated range is the effective one", async () => {
    await mount(WithdrawBitcoin);
    expect(stub.getSwapLimits).toHaveBeenCalled();
    expect(text()).toContain("Minimum: 300,000 sats. Maximum: 1,500,000 sats.");
  });

  it("an amount below the effective minimum is flagged with it", async () => {
    await mount(WithdrawBitcoin);
    await typeAmount("260000");
    expect(text()).toContain("Withdrawal must be at least 300,000 sats.");
  });
});

describe("D1.8 — Top Up shows loopd's figures when they are stricter", () => {
  beforeEach(() => stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(500_000) }));

  it("the stated minimum is the effective one", async () => {
    await mount(RefillChannel);
    expect(stub.getSwapLimits).toHaveBeenCalled();
    expect(text()).toContain("Minimum: 150,000 sats");
  });

  it("an amount below the effective minimum is flagged with it", async () => {
    await mount(RefillChannel);
    await typeAmount("120000");
    expect(text()).toContain("Minimum top up is 150,000 sats");
  });
});
