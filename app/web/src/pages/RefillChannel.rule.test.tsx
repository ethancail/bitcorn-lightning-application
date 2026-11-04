// Drive-mode P1 item 8 (spec P1 item 8; D1.10): Top Up's warning and its
// maximum come from the one rule the server states (/api/swaps/limits →
// loop_in.onchain_floor_sats, available_now_sats), not from the page's own
// `balance − 50,000 − 10,000` and `< 60,000` literals.
//
// The server figures below are the rule at 10 sat/vB with one anchor channel:
// floor = 100,000 + 50,000 + 2,210 + 10,000 = 162,210; overhead 62,210.
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
  getSwapLimits: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./RefillChannel";

const FLOOR = 162_210;
const OVERHEAD = 62_210;

function limitsFor(balance: number) {
  return {
    loop_available: true,
    loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 0 },
    loop_in: {
      min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
      onchain_rule: {
        reserve_sats: 50_000, anchor_channels: 1, anchor_reserve_sats: 10_000,
        fee_rate_sat_per_vbyte: 10, htlc_tx_vbytes: 221, estimated_htlc_fee_sats: 2_210,
      },
      onchain_floor_sats: FLOOR,
      available_now_sats: Math.max(0, balance - OVERHEAD),
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({
    treasury_channel: {
      channel_id: "1", local_sats: 200_000, remote_sats: 3_700_000, capacity_sats: 4_000_000, is_active: true,
      room_to_send_sats: 160_000, room_to_receive_sats: 3_660_000, local_reserve_sats: 40_000, remote_reserve_sats: 40_000,
      pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: null,
      freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
    },
  });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

async function mountAt(balance: number) {
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: balance, lightning_sats: 0, total_sats: balance });
  stub.getSwapLimits.mockResolvedValue(limitsFor(balance));
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("D1.10 — the warning and the maximum follow the server's rule", () => {
  it("100,000 in the wallet (above the old 60,000): warned, naming the floor", async () => {
    await mountAt(100_000);
    expect(text()).toContain(`you need at least ${FLOOR.toLocaleString()} sats`);
  });

  it("exactly the floor: no warning; the most you can add is the minimum, 100,000", async () => {
    await mountAt(FLOOR);
    expect(text()).not.toContain("Not enough in your Bitcoin balance");
    const max = [...host.querySelectorAll("button")].find((b) => b.getAttribute("title") === "100,000 sats");
    expect(max, "Max is the server's available_now").toBeDefined();
  });

  it("the floor + 10,000: the most you can add is 110,000 (not balance − 60,000)", async () => {
    await mountAt(FLOOR + 10_000);
    const titles = [...host.querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(titles).toContain("110,000 sats");
    expect(titles).not.toContain(`${(FLOOR + 10_000 - 60_000).toLocaleString()} sats`);
  });
});
