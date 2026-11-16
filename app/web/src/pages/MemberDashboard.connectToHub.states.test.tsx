// member-first-run-ui separation slice — done-when (1), ConnectToHub.
//
// WHAT THIS PROVES: every state ConnectToHub can render produces the same DOM
// (text and every attribute, the confirm modal's portal included) and the same
// handler calls before and after the component moves out of MemberDashboard.tsx.
//
// HOW: the "before" is the .snap file written by this test against the
// pre-move code (commit A). The move (commit B) must leave that file
// byte-identical and these tests green under CI=1, which refuses to write a
// missing or changed snapshot. Rendering goes through MemberDashboard, the
// component that contains ConnectToHub on both sides of the move, so this file
// needs no edit between A and B.
//
// Choice (member-first-run-ui slice 1, ruled 2026-11-13): the fee-speed
// picker is now a Choice of native radios, so these snapshots were rewritten on
// purpose for it, feeCard() finds the radio's card, serialize() records each
// radio's checked property, and React's useId values (":r3:", which count up
// across every root in the file) are normalised so a snapshot doesn't depend on
// which tests ran before it. Values, default and labels are pinned in
// components/firstRun/ConnectToHub.feePins.test.tsx.
//
// Harness: MemberDashboard.namePrompt.test.tsx's (createRoot + act, vi.mock of
// the API client).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getMemberStats: vi.fn(),
  getPendingChannels: vi.fn(),
  getMemberLiquidityStatus: vi.fn(),
  getExchangeRate: vi.fn(),
  getNodeBalances: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getTreasuryInfo: vi.fn(),
  getBitcornName: vi.fn(),
  getSwapLimits: vi.fn(),
  getMemberCosts: vi.fn(), // drive-mode P2 item 14: a new dashboard read
  openMemberChannel: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
// Recharts + a live Coinbase fetch; irrelevant to ConnectToHub.
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";

const never = () => new Promise<never>(() => {});

const NOW = 1_790_000_000_000;

const CHANNEL_LESS = {
  hub_pubkey: null,
  membership_status: "active",
  node_role: "member",
  is_peered_to_hub: false,
  keysend_enabled: false,
  lnd_live_read_ok: true,
  cert_expiry: null,
  treasury_channel: null,
  forwarded_fees: { total_sats: 0, last_24h_sats: 0, last_30d_sats: 0 },
};

const WITH_CHANNEL = {
  ...CHANNEL_LESS,
  is_peered_to_hub: true,
  treasury_channel: {
    channel_id: "1",
    local_sats: 500_000,
    remote_sats: 500_000,
    capacity_sats: 1_000_000,
    is_active: true,
    freshness: { updated_at_ms: NOW, age_seconds: 0, staleness: "fresh" },
  },
};

const TREASURY_PUBKEY_FIXTURE = "03" + "c".repeat(64);
const HUB_SOCKET = "198.51.100.7:9735";

// ─── DOM capture: text and every attribute, in document order ──────────────

function serialize(node: Node, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent === "" ? [] : [`${pad}${JSON.stringify(node.textContent)}`];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const attrs = [...el.attributes]
    .map((a) => `${a.name}=${JSON.stringify(a.value.replace(/:r[0-9a-z]+:/g, ":r:"))}`)
    .sort();
  // A controlled input's live value is a property, not always the attribute.
  if (el instanceof HTMLInputElement) attrs.push(`prop:value=${JSON.stringify(el.value)}`);
  if (el instanceof HTMLInputElement && el.type === "radio") attrs.push(`prop:checked=${el.checked}`);
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) attrs.push(`prop:disabled=${el.disabled}`);
  const open = `${pad}<${el.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return [open, ...[...el.childNodes].flatMap((c) => serialize(c, depth + 1))];
}

/** The ConnectToHub region at either call site, plus anything portalled to body. */
function capture(): string {
  const regions: Element[] = [];
  for (const panel of host.querySelectorAll(".panel")) {
    const title = panel.querySelector(".panel-title")?.textContent ?? "";
    if (title.includes("Connect to Hub")) regions.push(panel);
  }
  for (const alert of host.querySelectorAll(".alert.info")) {
    if ((alert.textContent ?? "").includes("Channel upgrade recommended")) regions.push(alert);
  }
  const portals = [...document.body.children].filter((c) => c !== host);
  const calls = {
    openMemberChannel: stub.openMemberChannel.mock.calls,
    getTreasuryInfo: stub.getTreasuryInfo.mock.calls.length,
  };
  return [
    `regions: ${regions.length}`,
    ...regions.flatMap((r) => serialize(r)),
    `portals: ${portals.length}`,
    ...portals.flatMap((p) => serialize(p)),
    `calls: ${JSON.stringify(calls)}`,
  ].join("\n");
}

// ─── Harness ───────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getMemberStats.mockResolvedValue(CHANNEL_LESS);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getMemberLiquidityStatus.mockResolvedValue(null);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000 });
  stub.getNodeBalances.mockResolvedValue({ onchain_sats: 0, lightning_sats: 0, total_sats: 0 });
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1_790_000_000 });
  stub.getSwapLimits.mockImplementation(never);
  stub.getMemberCosts.mockImplementation(never);
  stub.openMemberChannel.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  for (const c of [...document.body.children]) c.remove();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function renderDashboard(entry = "/dashboard"): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/dashboard", element: React.createElement(MemberDashboard) }),
        ),
      ),
    );
  });
  await flush();
}

const btn = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

/** A fee-speed card, found by its label line. */
const feeCard = (label: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>("label.choice-option")].find((o) => o.querySelector(".choice-label")?.textContent === label);

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

const input = (label: string) => host.querySelector(`input[aria-label='${label}']`) as HTMLInputElement;
const challenge = () => document.body.querySelector("#action-confirm-challenge") as HTMLInputElement;

/** Open the modal and satisfy its typed challenge for `sats`. */
async function openAndConfirm(sats: string): Promise<void> {
  await click(btn("Open Channel →")!);
  await type(challenge(), sats);
  await click(btn("Open channel")!);
}

// ─── States ────────────────────────────────────────────────────────────────

describe("ConnectToHub, the no-channel call site (MemberDashboard :731)", () => {
  it("state 1 — peered to the hub", async () => {
    stub.getMemberStats.mockResolvedValue({ ...CHANNEL_LESS, is_peered_to_hub: true });
    await renderDashboard();
    expect(capture()).toContain("Connected to hub — ready to open a channel");
    expect(capture()).toMatchSnapshot();
  });

  it("state 2 — not peered, the hub's socket is known", async () => {
    stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET });
    await renderDashboard();
    expect(capture()).toContain("Hub address available");
    expect(capture()).toMatchSnapshot();
  });

  it("state 3 — not peered, the treasury info is still loading", async () => {
    stub.getTreasuryInfo.mockImplementation(never);
    await renderDashboard();
    expect(capture()).toContain("loading-shimmer");
    expect(capture()).toMatchSnapshot();
  });

  it("state 4 — not peered, no socket (treasury info null): the manual address field", async () => {
    await renderDashboard();
    expect(capture()).toContain("ask your operator");
    expect(capture()).toMatchSnapshot();
  });

  it("state 4b — not peered, the treasury-info read rejected: the manual address field", async () => {
    stub.getTreasuryInfo.mockRejectedValue(new Error("down"));
    await renderDashboard();
    expect(capture()).toContain("ask your operator");
    expect(capture()).toMatchSnapshot();
  });

  it("state 5 — the hub node ID row shows the treasury's pubkey when it has one", async () => {
    stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: null });
    await renderDashboard();
    expect(capture()).toContain(TREASURY_PUBKEY_FIXTURE);
    expect(capture()).toMatchSnapshot();
  });

  it("state 6a — the upgrade query preselects the 5M preset", async () => {
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    expect(input("Channel Capacity").value).toBe((5_000_000).toLocaleString());
    expect(capture()).toMatchSnapshot();
  });

  it("state 6b — a preset click selects it", async () => {
    await renderDashboard();
    await click(btn("10M")!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 6c — a typed custom capacity selects no preset", async () => {
    await renderDashboard();
    await type(input("Channel Capacity"), "2500000");
    expect(capture()).toMatchSnapshot();
  });

  it("state 7a — below the minimum: the warning shows and the button is disabled", async () => {
    await renderDashboard();
    await type(input("Channel Capacity"), "50000");
    expect(btn("Open Channel →")!.disabled).toBe(true);
    expect(capture()).toMatchSnapshot();
  });

  it("state 7b — an empty capacity: no warning, the button is disabled", async () => {
    await renderDashboard();
    await type(input("Channel Capacity"), "");
    expect(btn("Open Channel →")!.disabled).toBe(true);
    expect(capture()).toMatchSnapshot();
  });

  it("state 8a — Normal fee speed selected", async () => {
    await renderDashboard();
    await click(feeCard("Normal")!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 8b — Priority fee speed selected", async () => {
    await renderDashboard();
    await click(feeCard("Priority")!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 9a — the confirm modal, auto-connect socket (portal on document.body)", async () => {
    stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET });
    await renderDashboard();
    await click(btn("Open Channel →")!);
    expect(document.body.querySelector(".dialog-overlay")).not.toBeNull();
    expect(capture()).toMatchSnapshot();
  });

  it("state 9b — the confirm modal, a manually typed address", async () => {
    await renderDashboard();
    await type(input("Hub Address"), "  203.0.113.5:9735  ");
    await click(btn("Open Channel →")!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 9c — the confirm modal, challenge typed (confirm enabled)", async () => {
    await renderDashboard();
    await click(btn("Open Channel →")!);
    await type(challenge(), "1000000");
    expect(btn("Open channel")!.disabled).toBe(false);
    expect(capture()).toMatchSnapshot();
  });

  it("state 10 — submitting: the request is pending (Economy sends no fee_rate)", async () => {
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(capture()).toContain("Connecting…");
    expect(capture()).toMatchSnapshot();
  });

  it("state 10b — submitting with Priority and a typed address: the request body", async () => {
    await renderDashboard();
    await click(feeCard("Priority")!);
    await type(input("Hub Address"), " 203.0.113.5:9735 ");
    await openAndConfirm("1000000");
    expect(capture()).toMatchSnapshot();
  });

  it("state 10c — submitting while auto-connecting to the hub's socket: the request body", async () => {
    stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET });
    await renderDashboard();
    await click(feeCard("Normal")!);
    await openAndConfirm("1000000");
    expect(capture()).toMatchSnapshot();
  });

  it("state 11a — a generic failure: the critical alert, modal closed", async () => {
    stub.openMemberChannel.mockRejectedValue(new Error("insufficient on-chain funds"));
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(capture()).toContain("insufficient on-chain funds");
    expect(capture()).toMatchSnapshot();
  });

  it("state 11b — a failure with no message: the fallback text", async () => {
    stub.openMemberChannel.mockRejectedValue({});
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(capture()).toContain("Failed to open channel");
    expect(capture()).toMatchSnapshot();
  });

  it("state 11c — a confirmation failure goes to the modal, not the form", async () => {
    stub.openMemberChannel.mockRejectedValue(
      Object.assign(new Error("mismatch"), { status: 409, code: "confirmation_mismatch" }),
    );
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(capture()).toContain("This is a bug — nothing was sent");
    expect(capture()).toMatchSnapshot();
  });

  it("state 11d — success with a funding txid", async () => {
    stub.openMemberChannel.mockResolvedValue({ funding_txid: "ab".repeat(32) });
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(capture()).toContain("Funding Transaction");
    expect(capture()).toMatchSnapshot();
  });

  it("state 11e — success with no funding txid ('submitted')", async () => {
    stub.openMemberChannel.mockResolvedValue({});
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(capture()).toContain("Channel opening submitted");
    expect(capture()).not.toContain("Funding Transaction");
    expect(capture()).toMatchSnapshot();
  });
});

describe("ConnectToHub, the upgrade call site (MemberDashboard :982)", () => {
  it("state 12 — upgrade banner: isPeered, the upgrade capacity preselected", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    expect(capture()).toContain("Channel upgrade recommended");
    expect(capture()).toContain("Connected to hub — ready to open a channel");
    expect(capture()).toMatchSnapshot();
  });

  it("state 12b — upgrade banner: confirm and submit", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    stub.openMemberChannel.mockResolvedValue({ funding_txid: "cd".repeat(32) });
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    await openAndConfirm("5000000");
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(capture()).toMatchSnapshot();
  });
});
