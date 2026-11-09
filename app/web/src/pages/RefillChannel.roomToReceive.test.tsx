// Drive-mode P3, item 5 (BACKLOG §2, owned by drive-mode): Top Up's "more than
// your connection can take" check uses ROOM TO RECEIVE — the most the
// connection can take in — not local balance + amount against capacity, which
// counts the reserves, commitment fee and anchors as room. The copy says
// "connection", not "channel" (R14 / the P2 terms).
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

const BALANCE = 1_000_000;

function limits() {
  return {
    loop_available: true,
    loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 0 },
    loop_in: {
      min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
      onchain_rule: {
        reserve_sats: 50_000, anchor_channels: 1, anchor_reserve_sats: 10_000,
        fee_rate_sat_per_vbyte: 10, htlc_tx_vbytes: 221, estimated_htlc_fee_sats: 2_210,
      },
      onchain_floor_sats: 162_210,
      available_now_sats: BALANCE - 62_210,
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: BALANCE, lightning_sats: 0, total_sats: BALANCE });
  stub.getSwapLimits.mockResolvedValue(limits());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");

// A 1,000,000 connection whose local side is 200,000. lnd's reserves and the
// commitment fee mean the remote side's room is far below capacity − local.
async function mountWith(roomToReceive: number) {
  stub.getMemberStats.mockResolvedValue({
    treasury_channel: {
      channel_id: "1", local_sats: 200_000, remote_sats: roomToReceive + 10_000, capacity_sats: 1_000_000, is_active: true,
      room_to_send_sats: 190_000, room_to_receive_sats: roomToReceive, local_reserve_sats: 10_000, remote_reserve_sats: 10_000,
      pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 1_532,
      freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
    },
  });
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const WARNING = "That's more than your connection can take right now. Try a smaller amount.";

describe("P3 — Top Up's 'can take' check reads room to receive", () => {
  it("amount (the 100,000 default) above room to receive (60,000) warns, though local + amount is well under capacity", async () => {
    await mountWith(60_000);
    expect(text()).toContain(WARNING);
  });

  it("amount within room to receive: no warning", async () => {
    await mountWith(700_000);
    expect(text()).not.toContain(WARNING);
  });

  it("the copy says connection, never channel", async () => {
    await mountWith(60_000);
    expect(text()).not.toContain("more than your channel can hold");
  });
});
