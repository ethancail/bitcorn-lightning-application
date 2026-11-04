// member-first-run-ui separation slice — done-when (1), ChannelRolePanel.
//
// WHAT THIS PROVES: every state the Settings page's Channel Role panel can
// render produces the same DOM (text and every attribute) and the same
// handler calls (setChannelRole, the "bitcorn:role-changed" event) before and
// after the panel moves out of App.tsx into a hook plus a markup component.
// The swallowed load and save errors are pinned as they are: carried, not fixed.
//
// HOW: the "before" is the .snap file this test wrote against the pre-move
// code (commit A); the move (commit B) must leave it byte-identical and these
// tests green under CI=1. Rendering goes through the real App at /settings, so
// this file needs no edit between A and B.
//
// Harness: App.declaredRole.test.tsx's (the REAL App, member shell; RailScope
// mocked by the existing pass-through pattern).

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
  setChannelRole: vi.fn(),
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
let roleChangedEvents = 0;
const onRoleChanged = () => { roleChangedEvents += 1; };

const LOOP = { loopDaemonRunning: false, loopOutAvailable: false, loopInAvailable: false, loopOutTerms: null, loopInTerms: null };

const statusWithRole = (channelRole: "merchant" | "farmer" | "unknown") => ({
  channelRole,
  classification: null,
  recommendation: null,
  loopAvailability: LOOP,
});

function serialize(node: Node, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent === "" ? [] : [`${pad}${JSON.stringify(node.textContent)}`];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const attrs = [...el.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort();
  if (el instanceof HTMLButtonElement) attrs.push(`prop:disabled=${el.disabled}`);
  const open = `${pad}<${el.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return [open, ...[...el.childNodes].flatMap((c) => serialize(c, depth + 1))];
}

/** The Channel Role panel, found by its title. */
function panel(): Element | undefined {
  return [...host!.querySelectorAll(".panel")].find(
    (p) => p.querySelector(".panel-title")?.textContent === "◈Channel Role",
  );
}

function capture(): string {
  const p = panel();
  return [
    `panel: ${p ? 1 : 0}`,
    ...(p ? serialize(p) : []),
    `calls: ${JSON.stringify({ setChannelRole: stub.setChannelRole.mock.calls, roleChangedEvents })}`,
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  roleChangedEvents = 0;
  window.addEventListener("bitcorn:role-changed", onRoleChanged);
  localStorage.removeItem("bitcorn_setup_done");
  stub.getNode.mockResolvedValue({ node_role: "node", alias: "lnd-alias", pubkey: "02" + "a".repeat(64), synced_to_chain: true });
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockResolvedValue(statusWithRole("unknown"));
  stub.setChannelRole.mockImplementation(never);
});

afterEach(async () => {
  window.removeEventListener("bitcorn:role-changed", onRoleChanged);
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderSettings() {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/settings");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  await settle();
}

const panelButton = (text: string) =>
  [...(panel()?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").includes(text)) as HTMLButtonElement | undefined;

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

describe("ChannelRolePanel — load", () => {
  it("loading: the status read is pending → the shimmer", async () => {
    stub.getMemberLiquidityStatus.mockImplementation(never);
    await renderSettings();
    expect(capture()).toContain("loading-shimmer");
    expect(capture()).toMatchSnapshot();
  });

  it("loaded, no role declared → both options, no badge, no Clear", async () => {
    await renderSettings();
    expect(capture()).not.toContain("Clear role selection");
    expect(capture()).toMatchSnapshot();
  });

  it("loaded, merchant → merchant selected, amber badge, Clear shown", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(statusWithRole("merchant"));
    await renderSettings();
    expect(capture()).toContain("badge-amber");
    expect(capture()).toMatchSnapshot();
  });

  it("loaded, farmer → farmer selected, green badge", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(statusWithRole("farmer"));
    await renderSettings();
    expect(capture()).toContain("badge-green");
    expect(capture()).toMatchSnapshot();
  });

  it("loaded, role only inside the classification (SH9 fallback) → farmer", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue({
      ...statusWithRole("unknown"),
      channelRole: undefined,
      classification: { channelRole: "farmer" },
    });
    await renderSettings();
    expect(capture()).toContain("badge-green");
    expect(capture()).toMatchSnapshot();
  });

  it("load rejected → swallowed, shown as no role (carried defect)", async () => {
    stub.getMemberLiquidityStatus.mockRejectedValue(new Error("down"));
    await renderSettings();
    expect(capture()).not.toContain("loading-shimmer");
    expect(capture()).toMatchSnapshot();
  });
});

describe("ChannelRolePanel — save", () => {
  it("saving: the write is pending → every option disabled", async () => {
    await renderSettings();
    await click(panelButton("Merchant")!);
    expect(panelButton("Farmer")!.disabled).toBe(true);
    expect(capture()).toMatchSnapshot();
  });

  it("save succeeds → the new role is shown and role-changed fires once", async () => {
    stub.setChannelRole.mockResolvedValue(undefined);
    await renderSettings();
    await click(panelButton("Farmer")!);
    expect(roleChangedEvents).toBe(1);
    expect(capture()).toMatchSnapshot();
  });

  it("save fails → swallowed: the role is unchanged, nothing fires (carried defect)", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(statusWithRole("merchant"));
    stub.setChannelRole.mockRejectedValue(new Error("refused"));
    await renderSettings();
    await click(panelButton("Farmer")!);
    expect(roleChangedEvents).toBe(0);
    expect(panelButton("Farmer")!.disabled).toBe(false);
    expect(capture()).toMatchSnapshot();
  });

  it("Clear role selection → setChannelRole(\"unknown\"), back to no role", async () => {
    stub.getMemberLiquidityStatus.mockResolvedValue(statusWithRole("merchant"));
    stub.setChannelRole.mockResolvedValue(undefined);
    await renderSettings();
    await click(panelButton("Clear role selection")!);
    expect(stub.setChannelRole).toHaveBeenCalledWith("unknown");
    expect(capture()).toMatchSnapshot();
  });
});
