// The live theme listener (PR 2): with System in effect, the app follows the
// device when its scheme changes on an open page. Before, App.tsx read
// prefers-color-scheme once, at load and when System was chosen, so an OS
// switch left an open page in the old theme until a reload.
//
// jsdom has no matchMedia; a controllable fake stands in. Each case re-imports
// App so its module-level initTheme() runs against that case's stored choice.
// Harness otherwise App.settingsNameLink.test.tsx's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const device = vi.hoisted(() => {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const state = { dark: true };
  (window as any).matchMedia = (media: string) => ({
    media,
    get matches() { return media.includes("dark") ? state.dark : !state.dark; },
    addEventListener: (_t: string, l: (e: { matches: boolean }) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: { matches: boolean }) => void) => listeners.delete(l),
  });
  return {
    state,
    listeners,
    /** The OS switches scheme while the page is open. */
    switchTo(dark: boolean) {
      state.dark = dark;
      for (const l of listeners) l({ matches: dark });
    },
  };
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
  vi.resetModules();
  device.listeners.clear();
  device.state.dark = true;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
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
});

const theme = () => document.documentElement.dataset.theme;

async function loadApp() {
  return (await import("./App")).default;
}

async function renderAppAt(path: string) {
  const App = await loadApp();
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

async function choose(el: HTMLElement, label: "Dark" | "Light" | "System") {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no ${label} theme button`);
  await act(async () => { btn.click(); });
}

describe("System theme follows the device live", () => {
  it("PERMITTING: no stored choice — an OS switch on an open page re-themes it", async () => {
    await loadApp();
    expect(theme()).toBe("dark");
    device.switchTo(false);
    expect(theme()).toBe("light");
    device.switchTo(true);
    expect(theme()).toBe("dark");
  });

  it("a stored Dark is not overridden by an OS switch", async () => {
    localStorage.setItem("bitcorn_theme", "dark");
    await loadApp();
    device.switchTo(false);
    expect(theme()).toBe("dark");
  });

  it("choosing Light in Settings stops the following, though the listener exists", async () => {
    const el = await renderAppAt("/settings");
    expect(device.listeners.size).toBe(1);
    await choose(el, "Light");
    device.switchTo(true);
    expect(theme()).toBe("light");
  });

  it("loaded with Dark stored, then System chosen in Settings — follows from then on", async () => {
    localStorage.setItem("bitcorn_theme", "dark");
    device.state.dark = false;
    const el = await renderAppAt("/settings");
    expect(theme()).toBe("dark");
    await choose(el, "System");
    expect(theme()).toBe("light");
    device.switchTo(true);
    expect(theme()).toBe("dark");
  });

  it("the listener is added once, however often System is chosen", async () => {
    const el = await renderAppAt("/settings");
    await choose(el, "Dark");
    await choose(el, "System");
    await choose(el, "System");
    expect(device.listeners.size).toBe(1);
  });
});
