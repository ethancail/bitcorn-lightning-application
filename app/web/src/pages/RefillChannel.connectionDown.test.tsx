// Drive-mode P3, R41(1): Top Up mirrors Withdraw (commit 1) when the hub
// channel is down. With member stats' treasury_channel.is_active === false the
// page shows P2's connection-down sentence, keeps Get Quote disabled, shows no
// option cards and offers no amounts (no presets, Max, input or "Most you can
// add"). Unknown (no treasury_channel) fails open, as Withdraw's does.
// The same commit says "connection" wherever Top Up's page said "channel" to a
// member. The confirmation dialog's title ("Refill this channel") is not the
// page's: it is loop-fee-ceilings' copy (actionConfirm/), left unchanged.
//
// Harness: optionCards.pages.test.tsx's.

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
  getNodeBalances: vi.fn(),
  getSwapLimits: vi.fn(),
  getSwapLoopInQuote: vi.fn(),
  getSwapOptions: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const { getSwapOptions, ...rest } = stub;
  return {
    ...actual,
    api: { ...(actual as any).api, ...rest },
    transfersApi: { ...(actual as any).transfersApi, getSwapOptions },
  };
});

import RefillChannel, { statusText } from "./RefillChannel";

const CONNECTION_DOWN =
  "Your connection to Bitcorn is down, so payments can't go through it right now. It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app.";

const CHANNEL = (isActive: boolean) => ({
  channel_id: "1", local_sats: 150_000, remote_sats: 840_000, capacity_sats: 1_000_000, is_active: isActive,
  room_to_send_sats: 140_000, room_to_receive_sats: 830_000, local_reserve_sats: 10_000, remote_reserve_sats: 10_000,
  pending_outgoing_sats: 0, pending_incoming_sats: 0, commit_fee_sats: 872,
  freshness: { updated_at_ms: Date.now(), age_seconds: 0, staleness: "fresh" },
});

const LIMITS = {
  loop_available: true,
  loop_out: { min_sats: 250_000, max_sats: 2_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000, available_now_sats: 0, always_stays: null },
  loop_in: {
    min_sats: 100_000, max_sats: 3_000_000, daily_max_sats: 5_000_000, daily_remaining_sats: 5_000_000,
    onchain_rule: null, onchain_floor_sats: 162_210, available_now_sats: 900_000,
  },
};

// The cards the server would send; the page must not show them while down.
const IN = {
  direction: "loop_in", state: "ok", strategy: "save", floor_sats: 200_000, room_sats: 140_000, calm: "unknown",
  min_sats: 100_000, trigger_sats: null, quote_state: "ok", reason: "room_low",
  cards: [
    { key: "now", amount_sats: 260_000, fee_sats: 3_300, over_fee_limit: false, recommended: true },
    { key: "wait_lower", amount_sats: null, fee_sats: null, over_fee_limit: false, recommended: false },
  ],
};

const QUOTE = {
  swap_request: {
    id: "11111111-2222-3333-4444-555555555555", swap_type: "loop_in", status: "quoted",
    amount_sat: 250_000, quote_expires_at: Date.now() + 10 * 60_000,
  },
  quote: { amount_sat: 250_000, swap_fee_sat: 171, miner_fee_sat: 3_875, htlc_publish_fee_sat: 0, total_fee_sat: 4_046 },
  ceilings: { max_swap_fee_sat: 171, max_miner_fee_sat: 3_875 },
  policy_check: { ok: true },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({ treasury_channel: CHANNEL(true) });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 100_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 1_000_000, lightning_sats: 150_000, total_sats: 1_150_000 });
  stub.getSwapLimits.mockResolvedValue(LIMITS);
  stub.getSwapOptions.mockResolvedValue(IN);
  stub.getSwapLoopInQuote.mockResolvedValue(QUOTE);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function mount() {
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
  await flush();
}

describe("Top Up while the connection is down (is_active false)", () => {
  it("shows the connection-down sentence, disables Get Quote, and shows no cards and no amounts", async () => {
    stub.getMemberStats.mockResolvedValue({ treasury_channel: CHANNEL(false) });
    await mount();

    const get = button("Get Quote");
    expect(get, "Get Quote renders").toBeDefined();
    expect(get!.disabled, "Get Quote is disabled while the connection is down").toBe(true);

    expect(host.querySelector('[data-testid="topup-connection-down"]')?.textContent).toBe(CONNECTION_DOWN);

    expect(host.querySelectorAll('[data-testid^="option-card-"]').length, "no option cards").toBe(0);
    expect(host.querySelector('input[aria-label="Amount"]'), "no amount input").toBeNull();
    for (const label of ["250k", "500k", "1M", "2M", "Max"]) {
      expect(button(label), `no "${label}" amount button`).toBeUndefined();
    }
    expect(text()).not.toContain("Most you can add");

    await act(async () => { get!.click(); });
    expect(stub.getSwapLoopInQuote).not.toHaveBeenCalled();
  });
});

describe("Top Up while the connection is up, or unknown", () => {
  it("is_active true: no sentence; cards, amounts and an enabled Get Quote", async () => {
    await mount();
    expect(host.querySelector('[data-testid="topup-connection-down"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid^="option-card-"]').length).toBe(2);
    expect(host.querySelector('input[aria-label="Amount"]')).not.toBeNull();
    expect(button("Max")).toBeDefined();
    expect(button("Get Quote")!.disabled).toBe(false);
  });

  it("no treasury_channel (unknown): fails open, as Withdraw does", async () => {
    stub.getMemberStats.mockResolvedValue({});
    await mount();
    expect(host.querySelector('[data-testid="topup-connection-down"]')).toBeNull();
    expect(button("Get Quote")!.disabled).toBe(false);
  });
});

describe("Top Up says 'connection', never 'channel', to a member", () => {
  it("the loading view", async () => {
    stub.getMemberStats.mockReturnValue(new Promise(() => {}));
    await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(RefillChannel))); });
    expect(text()).toContain("Top Up");
    expect(text()).toContain("into your connection so you can send");
    expect(text()).not.toMatch(/channel/i);
  });

  it("the form, connected and disconnected", async () => {
    await mount();
    expect(text()).toContain("Connection Balance");
    expect(text()).not.toMatch(/channel/i);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    stub.getMemberStats.mockResolvedValue({ treasury_channel: CHANNEL(false) });
    await mount();
    expect(text()).not.toMatch(/channel/i);
  });

  it("the quote", async () => {
    await mount();
    await act(async () => { button("Get Quote")!.click(); });
    await flush();
    expect(text()).toContain("Added to Connection");
    expect(text()).not.toMatch(/channel/i);
  });

  it("every status sentence", () => {
    for (const s of ["quote_created", "initiating", "initiated", "executing", "confirming", "completed", "failed", "expired"]) {
      expect(statusText(s, 250_000, null), s).not.toMatch(/channel/i);
    }
    expect(statusText("executing", 250_000, null)).toBe("Moving funds into your connection...");
    expect(statusText("completed", 250_000, null)).toBe("Top up complete. 250,000 sats added to your connection.");
  });
});
