// drive-mode P2 item 7 on Withdraw and Top Up: a failed swap's status, and its
// row in the history, read the member-facing sentence for failure_reason
// (components/loopFailureCopy.ts), never the raw code. The raw value stays in
// Technical details, one tap down.
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

const swap = (swap_type: "loop_out" | "loop_in", status: string, failure_reason: string | null) => ({
  id: "s1", created_at: 1_790_000_000_000, updated_at: 1_790_000_000_000, node_pubkey: "03" + "a".repeat(64),
  role: "member", swap_type, direction: swap_type === "loop_out" ? "out" : "in", status,
  amount_sat: 500_000, quoted_fee_sat: 2_000, quoted_swap_fee_sat: 1_000, quoted_prepay_sat: 30_000,
  quoted_miner_fee_sat: 1_000, actual_fee_sat: null, destination_address: "bcrt1qdest", channel_id: null,
  quote_expires_at: null, failure_reason, notes: null,
});

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

const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
/** The text inside closed <details> (Technical details). */
const detailsText = () => [...host.querySelectorAll("details")].map((d) => d.textContent ?? "").join(" | ");
/** The text outside every <details>. */
function outsideDetails(): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details").forEach((d) => d.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ");
}

const WITHDRAW_OFFCHAIN =
  "Loop couldn't route the withdrawal's Lightning payment within its fee limit, so it stopped. " +
  "The amount stayed in your connection, but the prepay may not come back. Try again later or with a smaller amount.";
const TOPUP_BALANCE =
  "Your Bitcoin balance didn't have enough confirmed bitcoin to start the top-up, so nothing was sent. " +
  "Wait for incoming bitcoin to confirm, or top up a smaller amount.";

describe("Withdraw: a failed swap reads its sentence", () => {
  it("the tracking panel: the sentence on screen, the raw code in Technical details", async () => {
    stub.getSwapHistory.mockResolvedValue({ swaps: [swap("loop_out", "executing", null)] });
    stub.getSwap.mockResolvedValue({ swap_request: swap("loop_out", "failed", "FAILURE_REASON_OFFCHAIN"), execution: null, events: [] });
    await mount(WithdrawBitcoin);
    expect(outsideDetails()).toContain(`Withdrawal failed. ${WITHDRAW_OFFCHAIN}`);
    expect(outsideDetails()).not.toContain("FAILURE_REASON_OFFCHAIN");
    expect(detailsText()).toContain("FAILURE_REASON_OFFCHAIN");
  });

  it("the history row, expanded: the sentence, the raw code one tap down", async () => {
    stub.getSwapHistory.mockResolvedValue({ swaps: [swap("loop_out", "failed", "FAILURE_REASON_OFFCHAIN")] });
    stub.getSwap.mockResolvedValue({ swap_request: swap("loop_out", "failed", "FAILURE_REASON_OFFCHAIN"), execution: null, events: [] });
    await mount(WithdrawBitcoin);
    const row = [...host.querySelectorAll("tbody tr")][0];
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(outsideDetails()).toContain(WITHDRAW_OFFCHAIN);
    expect(outsideDetails()).not.toContain("FAILURE_REASON_OFFCHAIN");
    expect(detailsText()).toContain("FAILURE_REASON_OFFCHAIN");
  });
});

describe("Top Up: a failed swap reads its sentence", () => {
  it("the tracking panel: the sentence on screen, the raw code in Technical details", async () => {
    stub.getSwapHistory.mockResolvedValue({ swaps: [swap("loop_in", "executing", null)] });
    stub.getSwap.mockResolvedValue({ swap_request: swap("loop_in", "failed", "FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE"), execution: null, events: [] });
    await mount(RefillChannel);
    expect(outsideDetails()).toContain(`Top up failed. ${TOPUP_BALANCE}`);
    expect(outsideDetails()).not.toContain("FAILURE_REASON");
    expect(detailsText()).toContain("FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE");
  });

  it("the history row, expanded: the sentence, the raw code one tap down", async () => {
    stub.getSwapHistory.mockResolvedValue({ swaps: [swap("loop_in", "failed", "FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE")] });
    stub.getSwap.mockResolvedValue({ swap_request: swap("loop_in", "failed", "FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE"), execution: null, events: [] });
    await mount(RefillChannel);
    const row = [...host.querySelectorAll("tbody tr")][0];
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(outsideDetails()).toContain(TOPUP_BALANCE);
    expect(outsideDetails()).not.toContain("FAILURE_REASON");
    expect(detailsText()).toContain("FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE");
  });
});

// R33 finding 9: a temporary failure is not final, so its badge and its status
// line say "not finished", matching the sentence. Display only: the stored
// status is still "failed".
describe("R33 finding 9: a temporary failure reads \"Not finished\"", () => {
  const badges = () => [...host.querySelectorAll(".badge")].map((b) => b.textContent);

  for (const [name, Page, type, prefix] of [
    ["Withdraw", WithdrawBitcoin, "loop_out", "Withdrawal not finished."],
    ["Top Up", RefillChannel, "loop_in", "Top up not finished."],
  ] as const) {
    it(`${name}: the tracking badge and the status line`, async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "executing", null)] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "failed", "FAILURE_REASON_TEMPORARY"), execution: null, events: [] });
      await mount(Page);
      expect(badges()).toContain("Not finished");
      expect(badges()).not.toContain("Failed");
      expect(outsideDetails()).toContain(`${prefix} The ${type === "loop_out" ? "withdrawal" : "top-up"} stopped partway`);
      expect(outsideDetails()).not.toMatch(/(Withdrawal|Top up) failed/);
    });

    it(`${name}: the history row and its expanded detail`, async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "failed", "FAILURE_REASON_TEMPORARY")] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "failed", "FAILURE_REASON_TEMPORARY"), execution: null, events: [] });
      await mount(Page);
      expect(badges()).toEqual(["1", "Not finished"]);
      const row = [...host.querySelectorAll("tbody tr")][0];
      await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await flush();
      expect(badges().filter((b) => b === "Not finished")).toHaveLength(2);
      expect(badges()).not.toContain("Failed");
    });

    it(`${name}: any other failure still badges "Failed"`, async () => {
      stub.getSwapHistory.mockResolvedValue({ swaps: [swap(type, "failed", "FAILURE_REASON_TIMEOUT")] });
      stub.getSwap.mockResolvedValue({ swap_request: swap(type, "failed", "FAILURE_REASON_TIMEOUT"), execution: null, events: [] });
      await mount(Page);
      expect(badges()).toContain("Failed");
    });
  }
});

it("sanity: the pages render", async () => {
  stub.getSwapHistory.mockResolvedValue({ swaps: [] });
  await mount(WithdrawBitcoin);
  expect(text()).toContain("Withdraw Bitcoin");
});
