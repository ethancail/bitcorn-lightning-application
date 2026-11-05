// drive-mode P2 on Withdraw:
//   item 15 (R26(8), R27(6)) — the gauge keeps its bar at local / capacity but
//     no longer claims that share is available to withdraw: it reads "In your
//     connection · N% of your connection". The withdrawable figure is the
//     server's "Most you can withdraw". D1.9's own figures: 114,535 sats in the
//     connection and nothing withdrawable.
//   item 16 (R11(4), R27(7)) — "Always stays to keep you connected", under
//     "Why not all of it?", from the server's always_stays, on Withdraw only.
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
  getPendingChannels: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
  getMemberCosts: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import WithdrawBitcoin from "./WithdrawBitcoin";
import RefillChannel from "./RefillChannel";
import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});

const channel = (local: number, capacity = 1_000_000) => ({
  channel_id: "1", local_sats: local, remote_sats: capacity - local, capacity_sats: capacity, is_active: true,
  room_to_send_sats: Math.max(0, local - 10_000), room_to_receive_sats: Math.max(0, capacity - local - 10_000),
  local_reserve_sats: 10_000, remote_reserve_sats: 10_000, pending_outgoing_sats: 0, pending_incoming_sats: 0,
  commit_fee_sats: null, freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
});

const ALWAYS = { total_sats: 64_533, reserve_sats: 10_000, fee_headroom_sats: 4_533, swap_buffer_sats: 50_000 };

const limits = (available_now_sats: number, always_stays: typeof ALWAYS | null = ALWAYS) => ({
  loop_available: true,
  loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats, always_stays },
  loop_in: { min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, onchain_rule: null, onchain_floor_sats: null, available_now_sats: null },
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
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 });
  stub.getMemberCosts.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount(C: React.ComponentType) {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(C))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

describe("item 15: Withdraw's gauge makes no withdrawable claim", () => {
  it("D1.9's figures: 114,535 in the connection, nothing withdrawable — no \"available to withdraw\" share", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(114_535) });
    stub.getSwapLimits.mockResolvedValue(limits(0));
    await mount(WithdrawBitcoin);
    expect(text()).not.toContain("available to withdraw");
    expect(text()).toContain("In your connection");
    expect(text()).toContain("11% of your connection");
    expect(text()).not.toContain("Current channel");
    expect(text()).not.toContain("In your channel");
  });

  it("the bar is still local / capacity", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(640_000) });
    stub.getSwapLimits.mockResolvedValue(limits(580_000));
    await mount(WithdrawBitcoin);
    const bar = host.querySelector("[data-testid='capacity-bar']") as HTMLElement;
    expect(bar.style.width).toBe("64%");
  });

  it("after an amount, the projection is a share of the connection, not of what is withdrawable", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(640_000) });
    stub.getSwapLimits.mockResolvedValue(limits(580_000));
    await mount(WithdrawBitcoin);
    expect(text()).toContain("After withdrawal: 64% → 39% of your connection");
  });
});

describe("item 16: \"Why not all of it?\" — what always stays, from the server", () => {
  it("one tap down on Withdraw: the total and its three parts", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(640_000) });
    stub.getSwapLimits.mockResolvedValue(limits(580_000));
    await mount(WithdrawBitcoin);
    const details = [...host.querySelectorAll("details")].find((d) => d.querySelector("summary")?.textContent === "Why not all of it?")!;
    expect(details).toBeDefined();
    expect(details.open).toBe(false);
    const rows = [...details.querySelectorAll("[data-testid='always-stays-row']")].map((r) => [
      r.children[0].textContent, r.children[1].textContent,
    ]);
    expect(rows).toEqual([
      ["Always stays to keep you connected", "64,533 sats"],
      ["Connection reserve", "10,000 sats"],
      ["Lightning fee headroom", "4,533 sats"],
      ["Swap buffer", "50,000 sats"],
    ]);
  });

  it("no hub channel (always_stays null): no disclosure", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(640_000) });
    stub.getSwapLimits.mockResolvedValue(limits(580_000, null));
    await mount(WithdrawBitcoin);
    expect(text()).not.toContain("Why not all of it?");
  });

  it("Withdraw only: neither Top Up nor the dashboard says it (R11(4))", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: channel(640_000) });
    stub.getSwapLimits.mockResolvedValue(limits(580_000));
    await mount(RefillChannel);
    expect(text()).toContain("Top Up");
    expect(text()).not.toMatch(/Always stays|Why not all of it/);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    stub.getMemberStats.mockResolvedValue({
      hub_pubkey: null, membership_status: "active_member", node_role: "member", is_peered_to_hub: true,
      keysend_enabled: false, lnd_live_read_ok: true, cert_expiry: null, treasury_channel: channel(640_000),
      forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
    });
    await mount(MemberDashboard);
    expect(text()).toContain("My Dashboard");
    expect(text()).not.toMatch(/Always stays|Why not all of it/);
  });
});
