// Control labels (PR 2): Settings' text-size slider has an accessible name.
//
// It had none: "Text Size" was a sibling <span>, not a label, so a screen
// reader announced an unnamed slider. The name now comes from that visible
// span through aria-labelledby, and the value reads as a percentage.
// Harness: App.settingsNameLink.test.tsx's (the REAL App at /settings).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getBitcornName: vi.fn(),
  getProfileAlias: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoBuyAlertBadge: vi.fn(),
  getDaybreakEdition: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout
  stub.getNode.mockResolvedValue({ node_role: "node", alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  delete (Element.prototype as any).scrollIntoView;
});

async function renderAppAt(path: string) {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return host;
}

/** Accessible name of a control, from aria-label or aria-labelledby only —
 *  the two mechanisms this app uses. */
function accessibleName(el: Element): string {
  const direct = el.getAttribute("aria-label");
  if (direct) return direct.trim();
  const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
}

describe("Settings text-size slider", () => {
  it("is named by its visible label, and reads its value as a percentage", async () => {
    const el = await renderAppAt("/settings");
    const slider = el.querySelector('input[type="range"]');
    expect(slider).toBeTruthy();
    expect(accessibleName(slider!)).toBe("Text Size");
    expect(slider!.getAttribute("aria-valuetext")).toBe("100%");
  });
});
