// D3: negative numbers render in --text, with the minus sign carrying the
// meaning, not in red. On the treasury dashboard that is the 24h net hero
// (.revenue-hero-num.negative) and Revenue Yield; .stat-value.negative has no
// consumer today and follows for consistency.
//
// Harness: Dashboard.alertHeadings.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { cssRules } from "../styleRules.testutil";

const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getAlerts: vi.fn(),
  getTreasuryMetrics: vi.fn(),
  getNodeBalances: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => null }));
vi.mock("../components/SubscriptionRevenuePanel", () => ({ default: () => null }));
vi.mock("../components/RailFeeRevenuePanel", () => ({ default: () => null }));

import Dashboard from "./Dashboard";

const period = (net: number, rebalance: number) => ({
  inbound_sats: 0, outbound_sats: 0, outbound_fees_sats: 0, forwarded_fees_sats: 10,
  rebalance_costs_sats: rebalance, net_sats: net,
});

const metrics = (o: { net24?: number; yield?: number; rebalance24?: number } = {}) => ({
  as_of: 0,
  all_time: period(1_000, 0),
  last_24h: period(o.net24 ?? 0, o.rebalance24 ?? 0),
  liquidity: {
    channels_total: { local_sats: 0, remote_sats: 0, capacity_sats: 0, active_count: 0, total_count: 0 },
    treasury_channel: null,
  },
  capital_efficiency: { capital_deployed_sats: 1_000_000, revenue_yield: o.yield ?? 0, revenue_per_1m_sats_deployed: 0, runway_days: null },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stub.getAlerts.mockResolvedValue([]);
  stub.getNodeBalances.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderWith(m: unknown) {
  stub.getTreasuryMetrics.mockResolvedValue(m);
  await act(async () => { root.render(React.createElement(Dashboard)); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

const colorOf = (selector: string) =>
  cssRules().find((r) => r.media === null && r.selectors.includes(selector))?.decls["color"];

const yieldValue = () => {
  const card = [...host.querySelectorAll(".stat-card")].find((c) => c.textContent?.includes("Revenue Yield"));
  expect(card, "the Revenue Yield card renders").toBeDefined();
  return card!.querySelector(".stat-value")!;
};

describe("D3: negative numbers are --text, not red", () => {
  it("the 24h net hero: a negative net carries .negative, and .negative is --text", async () => {
    await renderWith(metrics({ net24: -500 }));
    const hero = host.querySelector(".revenue-hero-num")!;
    expect(hero.className).toBe("revenue-hero-num negative");
    expect(hero.textContent).toBe("−500");
    expect(colorOf(".revenue-hero-num.negative")).toBe("var(--text)");
  });

  it(".stat-value.negative is --text too", () => {
    expect(colorOf(".stat-value.negative")).toBe("var(--text)");
  });

  it("a negative Revenue Yield is --text, with its minus sign", async () => {
    await renderWith(metrics({ yield: -20 }));
    expect(yieldValue().textContent).toBe("-20");
    expect(yieldValue().getAttribute("style")).toContain("color: var(--text)");
  });

  it("PERMITTING: a positive Revenue Yield stays green", async () => {
    await renderWith(metrics({ yield: 20 }));
    expect(yieldValue().getAttribute("style")).toContain("color: var(--green)");
  });
});
