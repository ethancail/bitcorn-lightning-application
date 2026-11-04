// Drive-mode P1, R22(h): Top Up's presets are filtered by the live minimum
// from GET /api/swaps/limits (loop_in.min_sats), as Withdraw's already are.
// Before, only the maximum filtered them, so with loopd's minimum above
// 250,000 the 250k preset was offered and then refused.
//
// Harness: RefillChannel.rule.test.tsx's.

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
  getSwapLimits: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./RefillChannel";

// Plenty in the wallet and in the channel, so the maximum filters nothing.
const BALANCE = 10_000_000;

function limitsWithMin(minSats: number) {
  return {
    loop_available: true,
    loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 0 },
    loop_in: {
      min_sats: minSats, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
      onchain_rule: {
        reserve_sats: 50_000, anchor_channels: 1, anchor_reserve_sats: 10_000,
        fee_rate_sat_per_vbyte: 10, htlc_tx_vbytes: 221, estimated_htlc_fee_sats: 2_210,
      },
      onchain_floor_sats: minSats + 62_210,
      available_now_sats: 3_000_000,
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({
    treasury_channel: {
      channel_id: "1", local_sats: 200_000, remote_sats: 9_700_000, capacity_sats: 10_000_000, is_active: true,
      room_to_send_sats: 100_000, room_to_receive_sats: 9_600_000, local_reserve_sats: 100_000, remote_reserve_sats: 100_000,
      pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: null,
      freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
    },
  });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: BALANCE, lightning_sats: 0, total_sats: BALANCE });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mountWithMin(minSats: number) {
  stub.getSwapLimits.mockResolvedValue(limitsWithMin(minSats));
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const presetLabels = () =>
  [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter((t) => /^\d+(\.\d)?[kM]$/.test(t));

describe("R22(h) — Top Up's presets respect the live minimum", () => {
  it("minimum 300,000: the 250k preset is not offered; the rest are", async () => {
    await mountWithMin(300_000);
    expect(presetLabels()).toEqual(["500k", "1M", "2M"]);
  });

  it("minimum 100,000: every preset is offered (the filter removes only what is below it)", async () => {
    await mountWithMin(100_000);
    expect(presetLabels()).toEqual(["250k", "500k", "1M", "2M"]);
  });

  it("minimum exactly 250,000: the 250k preset stays (the minimum itself is allowed)", async () => {
    await mountWithMin(250_000);
    expect(presetLabels()).toContain("250k");
  });
});
