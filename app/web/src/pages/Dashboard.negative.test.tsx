// D3: negative numbers render in --text, with the minus sign carrying the
// meaning, not in red. On the treasury dashboard that is the 24-hour net
// headline number (.hl-value.negative, PR 6's H2) and Revenue Yield;
// .stat-value.negative has no consumer here and follows for consistency.
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

// `yield` is revenue_per_1m_sats_deployed, the field the tile shows (J7).
const metrics = (o: { net24?: number; yield?: number; rebalance24?: number } = {}) => ({
  as_of: 0,
  all_time: period(1_000, 0),
  last_24h: period(o.net24 ?? 0, o.rebalance24 ?? 0),
  liquidity: {
    channels_total: { local_sats: 0, remote_sats: 0, capacity_sats: 0, active_count: 0, total_count: 0 },
    treasury_channel: null,
  },
  capital_efficiency: { capital_deployed_sats: 1_000_000, revenue_yield: 0, revenue_per_1m_sats_deployed: o.yield ?? 0, runway_days: null },
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
  const card = [...host.querySelectorAll(".figure")].find((c) => c.textContent?.includes("Revenue yield"));
  expect(card, "the Revenue Yield figure renders").toBeDefined();
  return card!.querySelector(".figure-value")!;
};

describe("D3: negative numbers are --text, not red", () => {
  it("the 24-hour net headline: a negative net carries .negative, and .negative is --text", async () => {
    await renderWith(metrics({ net24: -500 }));
    const hl = host.querySelector(".hl-1 .hl-value")!;
    expect(hl.className).toBe("hl-value negative");
    expect(hl.querySelector(".hl-num")!.textContent).toBe("−500");
    expect(colorOf(".hl-value.negative")).toBe("var(--text)");
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

describe("E: the 24h rebalance cost is --text, never red", () => {
  const costValue = () => {
    const row = [...host.querySelectorAll(".kv")].find((c) => c.textContent?.includes("Rebalance costs"));
    expect(row, "the Rebalance costs row renders").toBeDefined();
    return row!.querySelector(".kv-value")!;
  };

  it("a 0 cost renders \"0\" in --text", async () => {
    await renderWith(metrics({ rebalance24: 0 }));
    expect(costValue().textContent).toBe("0sats");
    expect(costValue().getAttribute("style")).toBe("color: var(--text);");
  });

  it("a non-zero cost still renders signed, in --text", async () => {
    await renderWith(metrics({ rebalance24: 1_234 }));
    expect(costValue().textContent).toBe("−1,234sats");
    expect(costValue().getAttribute("style")).toBe("color: var(--text);");
  });
});
