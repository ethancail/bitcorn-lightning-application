// SH1: the treasury dashboard's alert rows print the heading the API sends,
// fall back to "Treasury alert" without one, and never print the raw type.
// X3 (PR 6): each alert is one compact row (AlertRow.tsx) whose detail is one
// tap away, in a closed native <details>; the valuation banner is the same
// row, with its action.
//
// The panels beside the alert list are stubbed out; only the list is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

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

import Dashboard, { TREASURY_ALERT_FALLBACK_HEADING } from "./Dashboard";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Rejected, not pending: the first load is a Promise.allSettled over metrics
  // and alerts, so a never-settling metrics read would hold the alerts back too.
  stub.getTreasuryMetrics.mockRejectedValue(new Error("metrics unavailable in this test"));
  stub.getNodeBalances.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const alert = (type: string, heading?: string) => ({
  type,
  ...(heading === undefined ? {} : { heading }),
  severity: "warning" as const,
  message: "the alert's detail",  // must not contain the type, or "never prints it" is unprovable
  data: {},
  at: 0,
});

async function renderWith(alerts: unknown[]) {
  stub.getAlerts.mockResolvedValue(alerts);
  await act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(Dashboard))); });
  await act(async () => { await Promise.resolve(); });
  return [...host.querySelectorAll(".alert-row-heading")].map((e) => e.textContent);
}

describe("treasury alert boxes print the server's heading", () => {
  it("prints the heading the API set", async () => {
    const headings = await renderWith([alert("DAILY_LOSS_CAP_EXCEEDED", "Daily loss limit reached")]);
    expect(headings).toEqual(["Daily loss limit reached"]);
  });

  it("never prints the raw type", async () => {
    await renderWith([alert("LOOP_NOT_INSTALLED", "Loop unavailable while channels need rebalancing")]);
    expect(host.textContent).not.toContain("LOOP_NOT_INSTALLED");
  });

  it("falls back to 'Treasury alert' when no heading arrives", async () => {
    expect(TREASURY_ALERT_FALLBACK_HEADING).toBe("Treasury alert");
    const headings = await renderWith([alert("SOMETHING_NEW")]);
    expect(headings).toEqual(["Treasury alert"]);
    expect(host.textContent).not.toContain("SOMETHING_NEW");
  });
});

describe("X3: compact rows, the detail one tap away", () => {
  it("each alert is one row: icon, heading, and its detail inside a closed <details>", async () => {
    await renderWith([alert("DAILY_LOSS_CAP_EXCEEDED", "Daily loss limit reached")]);
    const rows = host.querySelectorAll(".alert.alert-row");
    expect(rows).toHaveLength(1);
    const details = rows[0].querySelector("details")!;
    expect(details, "a native disclosure").not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("Daily loss limit reached");
    expect(details.querySelector("summary")!.textContent).not.toContain("the alert's detail");
    expect(details.querySelector(".alert-row-detail")!.textContent).toBe("the alert's detail");
  });

  it("the valuation banner is a row too: the server's heading, its detail folded, \"Enter now\" beside", async () => {
    await renderWith([alert("VALUATION_MANUAL_STALE", "Valuation inputs need attention")]);
    const rows = host.querySelectorAll(".alert.alert-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".alert-row-heading")!.textContent).toBe("Valuation inputs need attention");
    expect(rows[0].querySelector("details .alert-row-detail")!.textContent).toBe("the alert's detail");
    const link = rows[0].querySelector(".alert-row-action a")!;
    expect(link.textContent).toBe("Enter now →");
    expect(link.getAttribute("href")).toBe("/valuation-input");
  });

  it("the valuation banner falls back to its own wording when no heading arrives", async () => {
    const headings = await renderWith([alert("VALUATION_MANUAL_STALE")]);
    expect(headings).toEqual(["Valuation inputs need attention"]);
    expect(host.textContent).not.toContain("VALUATION_MANUAL_STALE");
  });
});
