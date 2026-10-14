// PR 6 on the treasury dashboard:
//   H2    — the headline numbers come first and in the ruled order: 24-hour
//           net, total capital, capital deployed.
//   CHART — the Bitcoin price chart is the section IMMEDIATELY beneath them
//           (the status line between is empty on a healthy load), before the
//           alert rows (SH7) and any tile.
//   J7    — Revenue Yield shows revenue_per_1m_sats_deployed, not the
//           revenue_yield fraction it used to round to 0.
//
// Harness: Dashboard.alertHeadings.test.tsx's; the chart is a marker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getAlerts: vi.fn(),
  getTreasuryMetrics: vi.fn(),
  getNodeBalances: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({
  default: () => React.createElement("div", { className: "panel price-tile", "data-testid": "price-chart" }),
}));
vi.mock("../components/SubscriptionRevenuePanel", () => ({ default: () => null }));
vi.mock("../components/RailFeeRevenuePanel", () => ({ default: () => null }));

import Dashboard from "./Dashboard";

const period = (net: number) => ({
  inbound_sats: 0, outbound_sats: 0, outbound_fees_sats: 0, forwarded_fees_sats: 0,
  rebalance_costs_sats: 0, net_sats: net,
});

const metrics = (o: { per1m?: number; fraction?: number; deployed?: number } = {}) => ({
  as_of: 0,
  all_time: period(9_000),
  last_24h: period(1_234),
  liquidity: {
    channels_total: { local_sats: 0, remote_sats: 0, capacity_sats: 0, active_count: 2, total_count: 3 },
    treasury_channel: null,
  },
  capital_efficiency: {
    capital_deployed_sats: o.deployed ?? 7_500_000,
    revenue_yield: o.fraction ?? 0.001234,
    revenue_per_1m_sats_deployed: o.per1m ?? 1_234,
    runway_days: null,
  },
});

const balances = { onchain_sats: 2_000_000, lightning_sats: 7_000_000, total_sats: 9_000_000 };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stub.getNodeBalances.mockResolvedValue(balances);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderWith(m: unknown, alerts: unknown[] = []) {
  stub.getTreasuryMetrics.mockResolvedValue(m);
  stub.getAlerts.mockResolvedValue(alerts);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Dashboard)));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

const labels = () => [...host.querySelectorAll(".headline .hl-label")].map((e) => e.textContent);
const nums = () => [...host.querySelectorAll(".headline .hl-num")].map((e) => e.textContent);

/** The dashboard's sections in order, skipping empty status lines (they
 *  render nothing: .headline-status:empty is display:none). */
function sections(): Element[] {
  const dash = host.querySelector(".dash")!;
  return [...dash.children].filter((c) => !(c.classList.contains("headline-status") && c.childElementCount === 0));
}

describe("H2: the treasury's headline numbers", () => {
  it("come first after the page header, in the ruled order", async () => {
    await renderWith(metrics());
    const s = sections();
    expect(s[0].classList.contains("dash-header")).toBe(true);
    expect(s[1].classList.contains("headline")).toBe(true);
    expect(labels()).toEqual(["24-hour net", "Total capital", "Capital deployed"]);
  });

  it("show the user's own money: 24h net, the balances' total, capital deployed", async () => {
    await renderWith(metrics());
    expect(nums()).toEqual(["+1,234", "9,000,000", "7,500,000"]);
  });

  it("before anything loads, each reads \"—\", never 0", async () => {
    stub.getNodeBalances.mockImplementation(() => new Promise(() => {}));
    stub.getTreasuryMetrics.mockImplementation(() => new Promise(() => {}));
    stub.getAlerts.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(Dashboard)));
    });
    expect(nums()).toEqual(["—", "—", "—"]);
  });
});

describe("CHART: the price chart sits immediately beneath the headline numbers", () => {
  it("with no alerts", async () => {
    await renderWith(metrics());
    const s = sections();
    const i = s.findIndex((e) => e.classList.contains("headline"));
    expect(s[i + 1].getAttribute("data-testid")).toBe("price-chart");
  });

  it("with alerts: the alert rows come after the chart (SH7)", async () => {
    await renderWith(metrics(), [
      { type: "DAILY_LOSS_CAP_EXCEEDED", heading: "Daily loss limit reached", severity: "critical", message: "m", data: {}, at: 0 },
      { type: "VALUATION_MANUAL_STALE", heading: "Valuation inputs need attention", severity: "warning", message: "m", data: {}, at: 0 },
    ]);
    const s = sections();
    const i = s.findIndex((e) => e.classList.contains("headline"));
    expect(s[i + 1].getAttribute("data-testid")).toBe("price-chart");
    const firstRow = s.findIndex((e) => e.classList.contains("alert-row") || e.querySelector(".alert-row"));
    expect(firstRow).toBeGreaterThan(i + 1);
  });

  it("the balance strip that used to come first is gone", async () => {
    await renderWith(metrics());
    expect(host.querySelector(".dashboard-top-strip")).toBeNull();
  });
});

describe("J7: Revenue Yield", () => {
  const yieldText = () =>
    [...host.querySelectorAll(".figure")].find((f) => f.textContent?.includes("Revenue yield"))!
      .querySelector(".figure-value")!.textContent;

  it("shows sats per 1M deployed (revenue_per_1m_sats_deployed)", async () => {
    await renderWith(metrics({ per1m: 1_234, fraction: 0.001234 }));
    expect(yieldText()).toBe("1,234");
  });

  it("is not the revenue_yield fraction, which rounds to 0", async () => {
    await renderWith(metrics({ per1m: 56, fraction: 0.000056 }));
    expect(yieldText()).toBe("56");
  });
});
