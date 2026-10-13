// SH9: a member's DECLARED role shows whether or not their channel is active.
//
// The API's classification is null while the treasury channel is inactive, and
// the shell read the role only from inside it — so a declared merchant with an
// inactive channel got the farmer nav ("Withdraw", /cashout) instead of "Top Up"
// (/refill), and Settings showed no role chosen. The API now returns the stored
// role at the top level; the shell and Settings read it.
//
// Harness: App.topbarName.test.tsx's (the REAL App, member shell).

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

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

/** The status an INACTIVE treasury channel produces: no classification. */
const inactiveWithRole = (channelRole: "merchant" | "farmer" | "unknown") => ({
  channelRole,
  classification: null,
  recommendation: null,
  loopAvailability: LOOP,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getNode.mockResolvedValue({ node_role: "node", alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
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

async function renderAppAt(path: string) {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const navHrefs = (el: Element) => [...el.querySelectorAll("nav a, .sidebar a")].map((a) => a.getAttribute("href"));
const navText = (el: Element) => el.querySelector(".sidebar")?.textContent ?? "";

describe("SH9: the declared role with an inactive channel", () => {
  it("PERMITTING: inactive channel, role merchant → the merchant nav (Top Up, /refill)", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("merchant"));
    const el = await renderAppAt("/daybreak");
    expect(navHrefs(el)).toContain("/refill");
    expect(navHrefs(el)).not.toContain("/cashout");
    expect(navText(el)).toContain("Top Up");
  });

  it("inactive channel, role farmer → the farmer nav (Withdraw, /cashout)", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("farmer"));
    const el = await renderAppAt("/daybreak");
    expect(navHrefs(el)).toContain("/cashout");
    expect(navHrefs(el)).not.toContain("/refill");
  });

  it("Settings shows the declared Merchant role as chosen while the channel is inactive", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(inactiveWithRole("merchant"));
    const el = await renderAppAt("/settings");
    const roleButton = (label: string) =>
      [...el.querySelectorAll("button.theme-option")].find((b) => (b.textContent ?? "").includes(label));
    expect(roleButton("Merchant")).toBeTruthy();
    // ChannelRolePanel marks the chosen role with .selected and a role badge.
    expect(roleButton("Merchant")!.classList.contains("selected")).toBe(true);
    expect(roleButton("Farmer")!.classList.contains("selected")).toBe(false);
    const panel = roleButton("Merchant")!.closest(".panel")!;
    expect(panel.querySelector(".panel-header .badge")?.textContent).toBe("merchant");
  });
});
