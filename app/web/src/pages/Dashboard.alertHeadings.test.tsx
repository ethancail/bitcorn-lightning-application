// SH1: the treasury dashboard's alert boxes print the heading the API sends,
// fall back to "Treasury alert" without one, and never print the raw type.
//
// Today's boxes, unchanged otherwise: .alert-type is still mono uppercase
// (ruling 5 — sentence case comes with PR 6's alert rows), so these assert the
// rendered TEXT, not its case on screen.
//
// The panels beside the alert list are stubbed out; only the list is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

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
  await act(async () => { root.render(React.createElement(Dashboard)); });
  await act(async () => { await Promise.resolve(); });
  return [...host.querySelectorAll(".alert-type")].map((e) => e.textContent);
}

describe("treasury alert boxes print the server's heading", () => {
  it("prints the heading the API set", async () => {
    const headings = await renderWith([alert("MEMBER_KEYSEND_DISABLED", "Keysend off for some member nodes")]);
    expect(headings).toEqual(["Keysend off for some member nodes"]);
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
