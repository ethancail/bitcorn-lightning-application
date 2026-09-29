// The receiving half of the dashboard name prompt's deep link.
//
// settings-name-clarity (Ethan, 2026-09-29): "Add name in Settings →" goes to
// /settings?focus=name (pinned in MemberDashboard.namePrompt.test.tsx), and
// SettingsPage turns that query into BitcornNamePanel's focusOnMount. The two
// halves are joined only by the literal `focus=name`, so a rename on either
// side breaks the link while each side's own test stays green — this file
// renders the REAL App at the URL the dashboard emits and asserts where focus
// lands. Harness: App.topbarName.test.tsx's.
//
// ⚠ THE PERMITTING CONTROL LEADS: with the query, the name field is focused.
// The paired case (no query → not focused) is what a Settings page that
// ignores the query would also produce.

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

/** The name panel's input: the one whose panel is headed "Your name for BitCorn". */
function nameInput(el: Element): HTMLInputElement {
  const panel = Array.from(el.querySelectorAll(".panel")).find((p) =>
    (p.querySelector(".panel-title")?.textContent ?? "").includes("Your name for BitCorn"),
  );
  const input = panel?.querySelector("input");
  if (!input) throw new Error("name panel input not rendered");
  return input as HTMLInputElement;
}

describe("the dashboard's deep link lands on the name field", () => {
  it("PERMITTING: /settings?focus=name → the name field is focused", async () => {
    const el = await renderAppAt("/settings?focus=name");
    expect(document.activeElement).toBe(nameInput(el));
  });

  it("paired: plain /settings → the name field is NOT focused", async () => {
    const el = await renderAppAt("/settings");
    expect(document.activeElement).not.toBe(nameInput(el));
  });
});
