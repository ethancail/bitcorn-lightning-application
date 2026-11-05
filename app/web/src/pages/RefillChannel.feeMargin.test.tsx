// Ruling tt (loop-fee-ceilings, v1.18.33), the page's half: Top Up passes the
// Loop In quote's miner_fee_margin_pct into authorizedMaxSats in mode
// "loop_in", so the confirmation's "Most you authorize in fees" includes the
// miner-fee margin. confirmAction.test.ts proves the arithmetic; this proves
// the wiring, by getting a quote on the page and opening its confirmation.
//
// Figures are tt's own (gate 1's Loop In): swap 171, quoted miner 3,875,
// margin 50% → 171 + ceil(3,875 × 150 / 100) = 5,984. Without the margin the
// sum of the ceilings is 4,046.
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
  getSwapLoopInQuote: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./RefillChannel";

const AMOUNT = 250_000;

function quote(marginPct: number | undefined) {
  return {
    swap_request: {
      id: "11111111-2222-3333-4444-555555555555", swap_type: "loop_in", status: "quoted",
      amount_sat: AMOUNT, quote_expires_at: Date.now() + 10 * 60_000,
    },
    quote: { amount_sat: AMOUNT, swap_fee_sat: 171, miner_fee_sat: 3_875, htlc_publish_fee_sat: 0, total_fee_sat: 4_046 },
    ceilings: { max_swap_fee_sat: 171, max_miner_fee_sat: 3_875 },
    ...(marginPct === undefined ? {} : { miner_fee_margin_pct: marginPct }),
    policy_check: { ok: true },
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
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 2_000_000, lightning_sats: 0, total_sats: 2_000_000 });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getSwapLimits.mockResolvedValue({
    loop_available: true,
    loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 0 },
    loop_in: {
      min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
      onchain_floor_sats: 162_210, available_now_sats: 1_937_790,
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

/** Mount, get a quote, open the confirmation; return the dialog's text. */
async function confirmationFor(marginPct: number | undefined): Promise<string> {
  stub.getSwapLoopInQuote.mockResolvedValue(quote(marginPct));
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
  await flush();
  const get = button("Get Quote");
  expect(get, "the Get Quote button renders").toBeDefined();
  await act(async () => { get!.click(); });
  await flush();
  expect(stub.getSwapLoopInQuote).toHaveBeenCalledWith({ amount_sat: AMOUNT });
  const confirm = button("Confirm Top Up");
  expect(confirm, "the quote panel renders").toBeDefined();
  await act(async () => { confirm!.click(); });
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog, "the confirmation opens").not.toBeNull();
  return (dialog!.textContent ?? "").replace(/\s+/g, " ");
}

describe("ruling tt — Top Up's \"Most you authorize in fees\" includes the miner-fee margin", () => {
  it("margin 50%: the confirmation shows 5,984 sats (171 + ceil(3,875 × 1.5)), not the 4,046 of the ceilings alone", async () => {
    const text = await confirmationFor(50);
    expect(text).toContain("Refill this channel");
    expect(text).toMatch(/Most you authorize in fees\s*5,984 sats/);
    expect(text).not.toMatch(/Most you authorize in fees\s*4,046 sats/);
  });

  it("no margin from the server: no maximum is shown (ruling ww), never the ceilings' sum", async () => {
    const text = await confirmationFor(undefined);
    expect(text).toContain("Refill this channel");
    expect(text).not.toContain("Most you authorize in fees");
  });
});
