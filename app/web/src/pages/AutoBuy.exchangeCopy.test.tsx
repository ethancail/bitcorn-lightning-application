// kraken-autobuy P6 (D-P6-2): the page header names the active exchange and
// its hold, from /status, as Ethan approved it. Harness as in
// AutoBuy.valuationNotice.test.tsx; the API is stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const config = (over: Record<string, unknown>) => ({
  enabled: true, base_unit_usd: 100, frequency: "weekly",
  zone_multipliers: { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 },
  currency_preference: "usd_only", withdraw_address: "bc1qstub", withdraw_address_whitelisted_at: 1,
  sweep_day_of_week: 0, consecutive_failures: 0, paused_reason: null, last_run_at: null, next_run_at: null,
  ...over,
});

const stub = vi.hoisted(() => ({
  getAutoBuyStatus: vi.fn(),
  getValuationCurrent: vi.fn(),
  getAutoBuyAlerts: vi.fn(async () => []),
  getAutoBuyHistory: vi.fn(async () => ({ rows: [], total: 0, limit: 25, offset: 0 })),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/autoBuy/CoinbaseCard", () => ({ default: () => React.createElement("div") }));
vi.mock("../components/autoBuy/KrakenCard", () => ({ default: () => React.createElement("div") }));
vi.mock("../components/autoBuy/HistoryTable", () => ({ default: () => React.createElement("div") }));

import AutoBuy from "./AutoBuy";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getValuationCurrent.mockRejectedValue(Object.assign(new Error("worker unreachable"), { code: "worker_unreachable", status: 502 }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function header(status: unknown): Promise<string> {
  stub.getAutoBuyStatus.mockResolvedValue(status);
  await act(async () => { root.render(React.createElement(AutoBuy)); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  return host.querySelector("h1 + p")?.textContent ?? "";
}
const status = (over: Record<string, unknown>) =>
  ({ config: config(over), credentials: null, in_flight: [], recent: [], missed: null, missed_error: null });

describe("the Auto-Buy header (P6)", () => {
  it("Kraken: names Kraken and its 7-day hold", async () => {
    expect(await header(status({ provider: "kraken", hold_seconds: 7 * 86400 }))).toBe(
      "Buys bitcoin on Kraken on a schedule, sized by the current valuation zone. Each buy waits out Kraken's 7-day withdrawal hold, then goes to your node's on-chain wallet on the weekly sweep.",
    );
  });
  it("Coinbase: names Coinbase and its 72-hour hold", async () => {
    expect(await header(status({ provider: "coinbase", hold_seconds: 72 * 3600 }))).toBe(
      "Buys bitcoin on Coinbase on a schedule, sized by the current valuation zone. Each buy waits out Coinbase's 72-hour withdrawal hold, then goes to your node's on-chain wallet on the weekly sweep.",
    );
  });
  it("before a status arrives, it names no exchange", async () => {
    stub.getAutoBuyStatus.mockRejectedValue(new Error("down"));
    await act(async () => { root.render(React.createElement(AutoBuy)); });
    await act(async () => { await Promise.resolve(); });
    const text = host.querySelector("h1 + p")?.textContent ?? "";
    expect(text).toContain("Buys bitcoin on your exchange");
    expect(text).not.toMatch(/Coinbase|Kraken/);
  });
});
