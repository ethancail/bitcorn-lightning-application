// membership-gating B1, Ethan's ruling (a), 2026-11-06: ConnectToHub shows an
// "Activate membership" primary button only when the node's subscription
// status gives open_channel_allowed === false. True, null, an absent field (an
// older treasury) and a failed status read all hide it. The button goes to
// /settings?focus=membership (the target pinned in
// App.settingsMembershipFocus.test.tsx) and mounts no pay-from-node modal.
//
// ⚠ THE PERMITTING CONTROL LEADS: the button is present on false. Every hidden
// case is also what a ConnectToHub with no button at all would produce.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getTreasuryInfo: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  openMemberChannel: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import ConnectToHub from "./ConnectToHub";

const LABEL = "Activate membership";
const URL = "/settings?focus=membership";

const PREPAY = {
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: "prepay",
  paid_through: 0,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: "bcrt1qexample",
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
};

let host: HTMLDivElement;
let root: Root;

function SettingsProbe() {
  const loc = useLocation();
  return React.createElement("div", { "data-probe": "settings" }, `SETTINGS at ${loc.pathname}${loc.search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.openMemberChannel.mockImplementation(() => new Promise(() => {}));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/dashboard",
            element: React.createElement(ConnectToHub, { isPeered: true }),
          }),
          React.createElement(Route, { path: "/settings", element: React.createElement(SettingsProbe) }),
        ),
      ),
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

function activateButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === LABEL) as HTMLButtonElement | undefined;
}

describe("B1 — the Activate membership button follows the treasury's verdict", () => {
  it("PERMITTING: open_channel_allowed false → the button shows, as a primary button", async () => {
    stub.getSubscriptionStatus.mockResolvedValue({ ...PREPAY, open_channel_allowed: false });
    await render();
    const b = activateButton();
    expect(b).toBeDefined();
    expect(b!.className).toBe("btn btn-primary");
  });

  it("clicking it navigates to exactly /settings?focus=membership, and opens no modal", async () => {
    stub.getSubscriptionStatus.mockResolvedValue({ ...PREPAY, open_channel_allowed: false });
    await render();
    await act(async () => { activateButton()!.click(); });
    expect(host.textContent).toBe(`SETTINGS at ${URL}`);
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
    expect(stub.openMemberChannel).not.toHaveBeenCalled();
  });

  it("hidden on true", async () => {
    stub.getSubscriptionStatus.mockResolvedValue({ ...PREPAY, current_tier: "current", open_channel_allowed: true });
    await render();
    expect(host.textContent).toContain("Open Channel");
    expect(activateButton()).toBeUndefined();
  });

  it("hidden on null (the treasury couldn't evaluate)", async () => {
    stub.getSubscriptionStatus.mockResolvedValue({ ...PREPAY, open_channel_allowed: null });
    await render();
    expect(host.textContent).toContain("Open Channel");
    expect(activateButton()).toBeUndefined();
  });

  it("hidden when the field is absent (a treasury that predates it)", async () => {
    stub.getSubscriptionStatus.mockResolvedValue({ ...PREPAY });
    await render();
    expect(activateButton()).toBeUndefined();
  });

  it("hidden when the status can't be fetched", async () => {
    stub.getSubscriptionStatus.mockRejectedValue(Object.assign(new Error("treasury_unreachable"), { status: 503 }));
    await render();
    expect(host.textContent).toContain("Open Channel");
    expect(activateButton()).toBeUndefined();
  });

  it("ConnectToHub and its hook import nothing from pay-from-node", () => {
    for (const f of ["ConnectToHub.tsx", "useConnectToHub.ts", "connectToHubDescriptor.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      const imports = src.split("\n").filter((l) => /^\s*import\b|from\s+["']/.test(l));
      expect(imports.filter((l) => /payFromNode|PayFromNode|pay-from-node/i.test(l))).toEqual([]);
    }
  });
});
