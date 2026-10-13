// Z1 (UI redesign round 1): ONE font for the whole app. The font presets and
// Settings' Font control are gone; text size stays. A member who once chose a
// preset still has "bitcorn_font" in storage — it is ignored (nothing applies
// it to <html>) and left in place (nothing deletes it).
//
// The stored preset is written BEFORE App is imported, because the old code
// applied it in initTheme() at module load. Harness: App.textSizeLabel.test.tsx's
// (the REAL App at /settings).
//
// ⚠ THE PERMITTING CONTROL LEADS: the Appearance panel and its Text Size slider
// render, so "no Font control" is not a page that failed to render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
  localStorage.setItem("bitcorn_font", "inter");
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

async function renderSettings() {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/settings");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return host;
}

describe("Z1: one font — no presets, no Font control, a stored preset ignored", () => {
  it("permitting: Settings renders Appearance with its Text Size slider", async () => {
    const el = await renderSettings();
    expect(el.textContent).toContain("Appearance");
    expect(el.querySelector('input[type="range"][aria-labelledby="settings-text-size-label"]')).not.toBeNull();
  });

  it("Settings has no Font control and no preset buttons", async () => {
    const el = await renderSettings();
    const labels = [...el.querySelectorAll("span, button")].map((n) => n.textContent?.trim());
    expect(labels).not.toContain("Font");
    for (const preset of ["IBM Plex", "Inter", "Source", "0123456789"]) {
      expect(el.textContent).not.toContain(preset);
    }
  });

  it("a stored preset sets no inline --sans or --mono on <html>, and stays in storage", async () => {
    await renderSettings();
    const s = document.documentElement.style;
    expect(s.getPropertyValue("--sans")).toBe("");
    expect(s.getPropertyValue("--mono")).toBe("");
    expect(localStorage.getItem("bitcorn_font")).toBe("inter");
  });
});
