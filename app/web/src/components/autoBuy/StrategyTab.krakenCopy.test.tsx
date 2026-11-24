// kraken-autobuy P6: StrategyTab's copy names the ACTIVE exchange and its hold
// (D-P6-2, D-P6-4, D-P6-6), as Ethan approved it, and Coinbase's wording is
// unchanged. The harness follows StrategyTab.missedBlock.test.tsx: createRoot
// inside act(), the API stubbed (the web's network guard fails any real request).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import type { AutoBuyStatus, AutoBuyMissed } from "../../api/client";

const stub = vi.hoisted(() => ({
  catchUpAutoBuy: vi.fn(),
  executeAutoBuyNow: vi.fn(),
  getAutoBuyHistory: vi.fn(async () => ({ rows: [], total: 0, limit: 25, offset: 0 })),
  enableAutoBuy: vi.fn(),
  pauseAutoBuy: vi.fn(),
  updateAutoBuyConfig: vi.fn(),
  getAutoBuyCredentialsStatus: vi.fn(async () => null),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./CoinbaseCard", () => ({ default: () => React.createElement("div", null, "coinbase-card-stub") }));
vi.mock("./KrakenCard", () => ({ default: () => React.createElement("div", null, "kraken-card-stub") }));
vi.mock("./ProviderChoice", () => ({ default: () => React.createElement("div", null, "provider-choice-stub") }));
vi.mock("./HistoryTable", () => ({ default: () => React.createElement("div", null, "history-stub") }));

import StrategyTab from "./StrategyTab";

const WEEK = 7 * 86400;
const NOW = 1789646400;
const KRAKEN = { provider: "kraken", hold_seconds: 7 * 86400 };
const COINBASE = { provider: "coinbase", hold_seconds: 72 * 3600 };

function cfg(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    base_unit_usd: 100,
    frequency: "weekly",
    zone_multipliers: { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 },
    currency_preference: "usd_only",
    withdraw_address: "bc1qstub",
    withdraw_address_whitelisted_at: NOW - 10 * WEEK,
    sweep_day_of_week: 0,
    consecutive_failures: 0,
    paused_reason: null,
    last_run_at: NOW - WEEK,
    next_run_at: NOW + WEEK,
    ...over,
  };
}

const MISSED: AutoBuyMissed = {
  intervals: 2,
  base_unit_usd: 100,
  oldest_slot: NOW - 2 * WEEK,
  newest_slot: NOW - 1 * WEEK,
  multiplier: 1,
  zone: "fair_value",
  valuation_updated_at: new Date(NOW * 1000).toISOString(),
  estimated_usd: 200,
  fits_now: { intervals: 2, estimated_usd: 200 },
  remainder: null,
};

const status = (over: Record<string, unknown>, missed: AutoBuyMissed | null = MISSED): AutoBuyStatus =>
  ({ config: cfg(over), credentials: null, in_flight: [], recent: [], missed, missed_error: null }) as unknown as AutoBuyStatus;

const valuation = { z_score: -0.4, zone: "fair_value", price_usd: 60000, updated_at: new Date(NOW * 1000).toISOString() } as any;

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}
const btn = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
function block(): string {
  const panel = Array.from(document.body.querySelectorAll(".panel")).find(
    (p) => p.querySelector(".panel-header")?.textContent?.trim() === "Missed buys",
  );
  return panel?.textContent ?? "";
}
async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const pageText = () => document.body.textContent ?? "";

/** Open the catch-up modal and return its text. */
async function openModal(over: Record<string, unknown>): Promise<string> {
  await render(React.createElement(StrategyTab, { status: status(over), valuation, onRefresh: async () => {} }));
  await click(btn("Buy missed intervals")!);
  return pageText();
}

/** Drive the catch-up to a refusal and return the block's text. */
async function refuse(over: Record<string, unknown>, body: unknown): Promise<string> {
  stub.catchUpAutoBuy.mockRejectedValue(Object.assign(new Error("refused"), { body }));
  await openModal(over);
  await type(document.body.querySelector("#action-confirm-challenge") as HTMLInputElement, "200.00");
  await click(btn("Buy now")!);
  return block();
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("the pause banner names the active exchange (D-P6-6)", () => {
  const cases: Array<[string, string, string]> = [
    ["no_credentials", "No Kraken key", "Connect a Kraken API key in the Kraken panel below."],
    ["credentials_invalid", "Kraken key refused", "Kraken rejected the API key. Create a new key with the five permissions and connect it. This also happens if another app uses the same key."],
    ["address_not_whitelisted", "Withdrawal address not set up in Kraken", "Save your node's address as a Bitcoin withdrawal address in Kraken and confirm it, then press Verify below."],
  ];
  for (const [reason, title, body] of cases) {
    it(`Kraken, ${reason}`, async () => {
      await render(React.createElement(StrategyTab, { status: status({ ...KRAKEN, enabled: false, paused_reason: reason }, null), valuation, onRefresh: async () => {} }));
      expect(pageText()).toContain(title);
      expect(pageText()).toContain(body);
      expect(pageText()).not.toContain("Coinbase");
    });
  }
  it("Coinbase keeps its own wording", async () => {
    await render(React.createElement(StrategyTab, { status: status({ ...COINBASE, enabled: false, paused_reason: "no_credentials" }, null), valuation, onRefresh: async () => {} }));
    expect(pageText()).toContain("No Coinbase credentials");
    expect(pageText()).not.toContain("No Kraken key");
  });
  it("a reason worded the same on both reads as before on Kraken", async () => {
    await render(React.createElement(StrategyTab, { status: status({ ...KRAKEN, enabled: false, paused_reason: "user_paused" }, null), valuation, onRefresh: async () => {} }));
    expect(pageText()).toContain("Paused by operator");
  });
});

describe("the catch-up confirm body names the exchange and its hold, from the API (D-P6-2)", () => {
  it("Kraken: 7-day", async () => {
    expect(await openModal(KRAKEN)).toContain("One market buy of about $200.00 on Kraken, then the usual 7-day hold and the weekly sweep.");
  });
  it("Coinbase: 72-hour", async () => {
    expect(await openModal(COINBASE)).toContain("One market buy of about $200.00 on Coinbase, then the usual 72-hour hold and the weekly sweep.");
  });
});

describe("catch-up refusals on Kraken", () => {
  it("an UNKNOWN outcome is not 'Not placed' (D-P6-4)", async () => {
    const text = await refuse(KRAKEN, { error: "order_outcome_unknown", reason: "fetch failed" });
    expect(text).toContain(
      "Kraken didn't confirm whether this buy went through. Nothing will be bought twice: Auto-Buy checks on its next run. See Orders in Kraken for the result.",
    );
    expect(text).not.toContain("Not placed");
  });
  it("the balance refusal names the Kraken balance", async () => {
    const text = await refuse(KRAKEN, {
      error: "insufficient_funds",
      funds: { needed_usd: 200, considered: ["USD"], usd_balance: 12.5, usdc_balance: null },
    });
    expect(text).toContain("Not placed: your Kraken USD balance is $12.50, below the $200.00 needed.");
  });
});
