// Drive-mode P3 (R40(5); the amount component spec §1.1): a past swap's fee
// shows in dollars only from the dollars STORED at completion
// (actual_fee_usd_cents, written only with a fresh rate); a row without them
// shows sats — never today's price on a historical record. Fixes P2's
// FeeReceipt, which converted at today's rate. Withdraw's and Top Up's
// history Fee cells get the same rule.
//
// Harness: receipt.pages.test.tsx's.

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
  getSwap: vi.fn(),
  getNodeAddress: vi.fn(),
  getSwapLimits: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import RefillChannel from "./RefillChannel";
import WithdrawBitcoin from "./WithdrawBitcoin";

const swap = (swap_type: "loop_out" | "loop_in", status: string, actual_fee_sat: number | null) => ({
  id: "s1", created_at: 1_790_000_000_000, updated_at: 1_790_000_000_000, node_pubkey: "03" + "a".repeat(64),
  role: "member", swap_type, direction: swap_type === "loop_out" ? "out" : "in", status,
  amount_sat: 500_000, quoted_fee_sat: 5_000, quoted_swap_fee_sat: 2_500, quoted_prepay_sat: 30_000,
  quoted_miner_fee_sat: 2_000, actual_fee_sat, destination_address: "bcrt1qdest", channel_id: null,
  quote_expires_at: null, failure_reason: null, notes: null,
});

// 2,500 + 1,800 + 21 = 4,321 sats; at $60,000 that is $2.59.
const RECEIPT = { total_sat: 4_321, swap_fee_sat: 2_500, network_fee_sat: 1_800, routing_fee_sat: 21 };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue({ treasury_channel: null });
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 10_000_000, lightning_sats: 0, total_sats: 10_000_000 });
  stub.getNodeAddress.mockResolvedValue({ address: "bcrt1qtestaddress" });
  stub.getSwapLimits.mockResolvedValue(null);
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

async function expandFirstRow() {
  const row = [...host.querySelectorAll("tbody tr")][0];
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

/** The receipt block: its summary, its sats line, and its breakdown rows. */
function receipt() {
  const el = host.querySelector("[data-testid='fee-receipt']");
  if (!el) return null;
  const details = el.querySelector("details")!;
  return {
    summary: el.querySelector("[data-testid='fee-summary']")!.textContent,
    sats: el.querySelector("[data-testid='fee-summary-sats']")?.textContent ?? null,
    open: details.open,
    toggle: details.querySelector("summary")!.textContent,
    rows: [...details.querySelectorAll("[data-testid='fee-part']")].map((r) => [
      r.querySelector("span")!.textContent,
      Number(r.getAttribute("data-sats")),
    ]),
  };
}


// Today's rate is $60,000 (harness); at it, 4,321 sats would read $2.59. The
// fee as of completion, stored, is 300 cents — $3.00 — so a page that shows
// $2.59 is using today's price on a past record.
const withUsd = (type: "loop_out" | "loop_in", cents: number | null) => ({ ...swap(type, "completed", 4_321), actual_fee_usd_cents: cents });
const feeCell = () => host.querySelector("tbody tr td[data-label='Fee']");

for (const [name, Page, type] of [["Withdraw", WithdrawBitcoin, "loop_out"], ["Top Up", RefillChannel, "loop_in"]] as const) {
  describe(`${name}: a past fee in dollars only as stored (R40(5))`, () => {
    it("the receipt's summary is the STORED dollars ($3.00), not today's ($2.59)", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [withUsd(type, 300)] });
      stub.getSwap.mockResolvedValue({ swap_request: withUsd(type, 300), execution: null, events: [], receipt: RECEIPT });
      await mount(Page);
      await expandFirstRow();
      expect(receipt()!.summary).toBe("$3.00");
      expect(receipt()!.sats).toBe("4,321 sats");
    });

    it("no stored dollars: the receipt shows sats, even with today's rate", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [withUsd(type, null)] });
      stub.getSwap.mockResolvedValue({ swap_request: withUsd(type, null), execution: null, events: [], receipt: RECEIPT });
      await mount(Page);
      await expandFirstRow();
      expect(receipt()!.summary).toBe("4,321 sats");
      expect(host.textContent).not.toContain("$2.59");
    });

    it("the history's Fee cell: stored dollars with sats beneath", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [withUsd(type, 300)] });
      await mount(Page);
      expect(feeCell()!.textContent).toContain("$3.00");
      expect(feeCell()!.textContent).toContain("4,321");
    });

    it("the history's Fee cell with nothing stored: sats only", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [withUsd(type, null)] });
      await mount(Page);
      expect(feeCell()!.textContent).toBe("4,321");
    });
  });
}
