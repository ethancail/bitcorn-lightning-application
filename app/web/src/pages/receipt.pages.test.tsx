// drive-mode P2 item 14 (D2.6) on Withdraw and Top Up: a completed swap shows
// a fee summary, dollars first with the sats underneath, and the breakdown
// behind a dropdown (the record :56); the breakdown sums to the summary.
//
// Harness: loopFailure.pages.test.tsx's.

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

const PARTS = [
  ["Swap service fee", 2_500],
  ["Bitcoin network fee", 1_800],
  ["Lightning routing", 21],
];

for (const [name, Page, type] of [["Withdraw", WithdrawBitcoin, "loop_out"], ["Top Up", RefillChannel, "loop_in"]] as const) {
  describe(`${name}: a completed swap's fee receipt`, () => {
    it("the expanded history row: a dollar summary, sats under it, the breakdown behind a dropdown", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "completed", 4_321)] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "completed", 4_321), execution: null, events: [], receipt: RECEIPT });
      await mount(Page);
      await expandFirstRow();
      const r = receipt()!;
      expect(r).not.toBeNull();
      expect(r.summary).toBe("$2.59");
      expect(r.sats).toBe("4,321 sats");
      expect(r.open).toBe(false);
      expect(r.toggle).toBe("Fee breakdown");
      expect(r.rows).toEqual(PARTS);
      // D2.6: the breakdown sums to the summary.
      expect(r.rows.reduce((s, [, v]) => s + (v as number), 0)).toBe(RECEIPT.total_sat);
      // Screenshot gate: in one column of the detail's two-column grid the
      // breakdown wrapped every label and value on a phone; it spans the row.
      const cell = host.querySelector("[data-testid='fee-receipt']")!.parentElement as HTMLElement;
      expect(cell.style.gridColumn).toBe("1 / -1");
    });

    it("the tracking panel, once completed: the same receipt", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "executing", null)] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "completed", 4_321), execution: null, events: [], receipt: RECEIPT });
      await mount(Page);
      const r = receipt()!;
      expect(r).not.toBeNull();
      expect(r.summary).toBe("$2.59");
      expect(r.rows).toEqual(PARTS);
    });

    it("no price: the summary is sats, with no second sats line", async () => {
      stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" });
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "completed", 4_321)] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "completed", 4_321), execution: null, events: [], receipt: RECEIPT });
      await mount(Page);
      await expandFirstRow();
      expect(receipt()!.summary).toBe("4,321 sats");
      expect(receipt()!.sats).toBeNull();
    });

    it("no receipt from the server: no receipt block", async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "completed", 4_321)] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "completed", 4_321), execution: null, events: [], receipt: null });
      await mount(Page);
      await expandFirstRow();
      expect(receipt()).toBeNull();
    });
  });
}
