// B-degraded says "see the notice above". This proves there IS one.
//
// ─── WHY THIS TEST RENDERS THE PAGE AND NOT THE TAB ─────────────────────────
// The pointer and its referent live on different components: the sentence is in
// StrategyTab's Missed-buys block, the notice is AutoBuy's valuation banner.
// A check at the tab level cannot see the banner at all and would pass however
// the gate were set — vacuous in the exact way this arc keeps finding. So the
// page is rendered, switched to the Strategy tab, and BOTH strings are asserted
// on screen at once.
//
// ─── THE DEFECT THIS PINS ───────────────────────────────────────────────────
// At 254f96e the banner was gated `tab === "valuation"` while the block is
// specified for Strategy, so a member in the degraded state would have read a
// pointer to nothing — the same class of defect as the arc's headline finding
// (a surface asserting something that is not there). The gate is now
// `valuation || strategy`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const WEEK = 7 * 86400;
const NOW = 1789646400;

const MISSED_DEGRADED = {
  intervals: 11,
  base_unit_usd: 100,
  oldest_slot: NOW - 11 * WEEK,
  newest_slot: NOW - 1 * WEEK,
  multiplier: null,
  zone: null,
  valuation_updated_at: null,
  estimated_usd: null,
  fits_now: null,
  remainder: null,
};

const STATUS = {
  config: {
    enabled: true,
    base_unit_usd: 100,
    frequency: "weekly",
    zone_multipliers: { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 },
    currency_preference: "usdc_preferred",
    withdraw_address: "bc1qstub",
    withdraw_address_whitelisted_at: NOW - 10 * WEEK,
    sweep_day_of_week: 0,
    consecutive_failures: 0,
    paused_reason: null,
    last_run_at: NOW - WEEK,
    next_run_at: NOW + WEEK,
  },
  credentials: null,
  in_flight: [],
  recent: [],
  missed: MISSED_DEGRADED,
  missed_error: null,
};

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
vi.mock("../components/autoBuy/HistoryTable", () => ({ default: () => React.createElement("div") }));

import AutoBuy from "./AutoBuy";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getAutoBuyStatus.mockResolvedValue(STATUS);
  // The valuation read FAILS — which is what makes the block degraded and the
  // banner appear. This is the state the customer's node was actually in.
  stub.getValuationCurrent.mockRejectedValue(
    Object.assign(new Error("worker unreachable"), { code: "worker_unreachable", status: 502 }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function renderPage(): Promise<void> {
  await act(async () => { root.render(React.createElement(AutoBuy)); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

// The tab's VISIBLE label, which is not its id: the ids are
// valuation/strategy/alerts, the labels "Valuation Chart" / "DCA Strategy" /
// "Alerts". Finding by label is what a member does.
const tabButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as
    | HTMLButtonElement
    | undefined;

describe("B-degraded's 'notice above' has a referent on the Strategy tab", () => {
  it("the pointer and the notice are on screen TOGETHER", async () => {
    await renderPage();

    const strategy = tabButton("DCA Strategy");
    expect(strategy, "strategy tab button not found").toBeDefined();
    await act(async () => { strategy!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });

    const text = host.textContent ?? "";
    // The pointer…
    expect(text).toContain("The amount can't be calculated right now — see the notice above.");
    // …and the thing it points at, from the page's own six-arm taxonomy.
    expect(text).toContain("Worker unreachable");
  });

  it("the notice is still on the VALUATION tab — widening the gate did not move it", async () => {
    // The permitting direction for this change: it had to ADD a surface, not
    // relocate one. A gate rewritten to `tab === "strategy"` would pass the
    // test above and silently break the tab the banner was written for.
    await renderPage();
    const text = host.textContent ?? "";
    expect(text).toContain("Worker unreachable");
  });
});
