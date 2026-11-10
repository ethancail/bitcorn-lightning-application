// The /settings?focus=membership target (membership-gating B1, with drive-mode's
// addendum, 2026-11-06). ConnectToHub's "Activate membership" button will
// navigate here, and drive-mode P3 will restructure Settings, so the target is
// pinned here by its hook, not by a CSS class or by text:
//
//   hook:   the element with id "settings-membership", wrapping SubscriptionPanel
//   focus:  scrolls that element into view, then moves keyboard focus to the
//           section's heading (its h2, tabIndex -1). No highlight is added.
//
// Red if the hook disappears, or if Settings stops responding to the query.
// Renders the REAL App at the URL; harness from App.settingsNameLink.test.tsx.
//
// ⚠ THE PERMITTING CONTROL LEADS: with the query, the heading is focused and the
// section scrolled. The paired case (no query → neither) is what a Settings page
// that ignores the query would also produce.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

const HOOK_ID = "settings-membership";

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
  // Resolves, so the panel leaves its loading skeleton for a settled state.
  stub.getSubscriptionStatus.mockResolvedValue({ applicable: false, reason: "no_channel" });
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

/** The section, found by its hook only. */
function section(): HTMLElement {
  const el = document.getElementById(HOOK_ID);
  if (!el) throw new Error(`no element with id "${HOOK_ID}": the Settings membership hook is gone`);
  return el;
}

function heading(): HTMLElement {
  const h = section().querySelector<HTMLElement>("h2");
  if (!h) throw new Error("the membership section has no heading");
  return h;
}

const scrolledElements = () => (Element.prototype.scrollIntoView as Mock).mock.contexts;

describe("/settings?focus=membership lands on the membership section", () => {
  it("PERMITTING: the section is scrolled into view and its heading has keyboard focus", async () => {
    await renderAppAt("/settings?focus=membership");
    expect(heading().textContent).toBe("Subscription");
    expect(scrolledElements()).toContain(section());
    expect(document.activeElement).toBe(heading());
  });

  it("the heading is focusable by script only (tabIndex -1)", async () => {
    await renderAppAt("/settings?focus=membership");
    expect(heading().getAttribute("tabindex")).toBe("-1");
  });

  it("paired: plain /settings → no scroll to the section, heading not focused", async () => {
    await renderAppAt("/settings");
    expect(scrolledElements()).not.toContain(section());
    expect(document.activeElement).not.toBe(heading());
  });
});
