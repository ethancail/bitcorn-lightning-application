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
// The Connect card (member-first-run-ui slice 2, Ethan's rulings relayed
// 2026-11-16): every snapshot here was rewritten ON PURPOSE for the new card.
// capture() now finds the card by its .connect-card container — the panel
// title and the upgrade alert it used to look for are gone — and ASSERTS it
// found at least one, so a broken lookup can't record an empty region and
// pass. Upgrade mode has no form (12); 12b is the page's pending panel. Below
// the snapshots: the empty amount box, upgrade-has-no-form with its control,
// the four rate states, and the wording check (no "channel" or "hub" in the
// card's member text).
//
// Ethan's ruling "fix the five" (2026-11-16) rewrote the snapshots ON PURPOSE
// again, display only: the fee cards' cost is FeeCost's (Normal "about $0.46"
// over "~770 sats"; Economy's words in .fee-cost-words), Technical details
// drops Economy's rate, and the upgrade card puts the size on its own line
// before one sentence. Each fix has its own test at the end of this file.
//
// fee-estimates (2026-11-18) rewrote the fee pins here ON PURPOSE, never
// deleting one (spec §13 item 8; MFRUI-ASKS (2)): every option, Economy
// included, now shows and sends a LIVE rate from GET /api/fee-estimates, so
// "Fee set by your node" and "network fee set by your node" are gone and
// Economy has a figure like the others. The estimate is stubbed at 1 / 5 /
// 15 sat/vB (FEES below) and every fee expectation is derived from that stub
// (H1). The snapshots were regenerated for it and the diff reviewed: the fee
// cards, the footer, Technical details, the confirm modal's new "Speed" row,
// the submitted copy ("usable after 2 confirmations") and the request bodies'
// fee_rate are the only changes.
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
  getFeeEstimates: vi.fn(), // fee-estimates: the card's live options
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});
// Recharts + a live Coinbase fetch; irrelevant to ConnectToHub.
vi.mock("../components/BitcoinPriceGraph", () => ({ default: () => React.createElement("div") }));

import MemberDashboard from "./MemberDashboard";
import { HUB_PUBKEY } from "../components/firstRun/connectToHubDescriptor";
import { feeEstimatesStub } from "../components/fees/feeEstimates.testutil";
import { timeText } from "../components/fees/feeEstimatesDescriptor";
import { formatSats, formatUsd } from "../components/amount/amountDescriptor";

/** The stubbed live estimate every fee expectation here derives from. */
const FEES = feeEstimatesStub({ economy: 1, normal: 5, priority: 15 });
const OPEN_SATS = { Economy: FEES.options!.economy.cost_sats.open, Normal: FEES.options!.normal.cost_sats.open, Priority: FEES.options!.priority.cost_sats.open };

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

/** The Connect card's panel at any call site, plus anything portalled to body. */
function capture(): string {
  const regions = cards().map((c) => c.closest(".panel") ?? c);
  // A lookup that finds nothing would snapshot "regions: 0" and pass.
  expect(regions.length, "capture() found no Connect card").toBeGreaterThanOrEqual(1);
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

/** Every Connect card on the page. */
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".connect-card")];

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
  stub.getFeeEstimates.mockResolvedValue(FEES);
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
const sizeCard = (sats: number): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(".connect-sizes label.choice-option")]
    .find((o) => o.querySelector(".amount")?.getAttribute("data-sats") === String(sats));
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

const sizeBox = () => host.querySelector("input[aria-label='Connection size in sats']") as HTMLInputElement;
const addressBox = () => host.querySelector(".connect-address input") as HTMLInputElement;
const challenge = () => document.body.querySelector("#action-confirm-challenge") as HTMLInputElement;

/** Open the modal and satisfy its typed challenge for `sats`. The dialog's
 *  main button is "Connect" since slice 5 (ruling (4)); it was "Open channel". */
async function openAndConfirm(sats: string): Promise<void> {
  await click(btn("Connect to BitCorn →")!);
  await type(challenge(), sats);
  await click(btn("Connect")!);
}

// ─── States ────────────────────────────────────────────────────────────────

describe("ConnectToHub, the no-channel call site (MemberDashboard :731)", () => {
  it("state 1 — peered to the hub", async () => {
    stub.getMemberStats.mockResolvedValue({ ...CHANNEL_LESS, is_peered_to_hub: true });
    await renderDashboard();
    expect(capture()).toContain("BitCorn reachable");
    expect(capture()).toMatchSnapshot();
  });

  it("state 2 — not peered, the hub's socket is known", async () => {
    stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET });
    await renderDashboard();
    expect(capture()).toContain("BitCorn's address is known");
    expect(capture()).toMatchSnapshot();
  });

  it("state 3 — not peered, the treasury info is still loading", async () => {
    stub.getTreasuryInfo.mockImplementation(never);
    await renderDashboard();
    expect(capture()).toContain("Checking BitCorn…");
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
    expect(sizeBox().value).toBe((5_000_000).toLocaleString());
    expect(capture()).toMatchSnapshot();
  });

  it("state 6b — a preset click selects it", async () => {
    await renderDashboard();
    await click(sizeCard(10_000_000)!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 6c — a typed custom capacity selects no preset", async () => {
    await renderDashboard();
    await type(sizeBox(), "2500000");
    expect(capture()).toMatchSnapshot();
  });

  it("state 7a — below the minimum: the warning shows and the button is disabled", async () => {
    await renderDashboard();
    await type(sizeBox(), "50000");
    expect(btn("Connect to BitCorn →")!.disabled).toBe(true);
    expect(capture()).toMatchSnapshot();
  });

  it("state 7b — an empty capacity: the box stays EMPTY, no warning, the button is disabled", async () => {
    await renderDashboard();
    await type(sizeBox(), "");
    expect(sizeBox().value).toBe("");
    expect(btn("Connect to BitCorn →")!.disabled).toBe(true);
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
    await click(btn("Connect to BitCorn →")!);
    expect(document.body.querySelector(".dialog-overlay")).not.toBeNull();
    expect(capture()).toMatchSnapshot();
  });

  it("state 9b — the confirm modal, a manually typed address", async () => {
    await renderDashboard();
    await type(addressBox(), "  203.0.113.5:9735  ");
    await click(btn("Connect to BitCorn →")!);
    expect(capture()).toMatchSnapshot();
  });

  it("state 9c — the confirm modal, challenge typed (confirm enabled)", async () => {
    await renderDashboard();
    await click(btn("Connect to BitCorn →")!);
    await type(challenge(), "1000000");
    expect(btn("Connect")!.disabled).toBe(false);
    expect(capture()).toMatchSnapshot();
  });

  it("state 10 — submitting: the request is pending (Economy sends its live rate)", async () => {
    await renderDashboard();
    await openAndConfirm("1000000");
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(stub.openMemberChannel.mock.calls[0][0].fee_rate).toBe(FEES.options!.economy.rate);
    expect(capture()).toContain("Connecting…");
    expect(capture()).toMatchSnapshot();
  });

  it("state 10b — submitting with Priority and a typed address: the request body", async () => {
    await renderDashboard();
    await click(feeCard("Priority")!);
    await type(addressBox(), " 203.0.113.5:9735 ");
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
    expect(capture()).toContain("Couldn't connect to BitCorn");
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
    expect(capture()).toContain("Connection submitted");
    expect(capture()).not.toContain("Funding Transaction");
    expect(capture()).toMatchSnapshot();
  });
});

describe("ConnectToHub, the upgrade call site (MemberDashboard :982)", () => {
  it("state 12 — upgrade mode: the heading and the current size, no form", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    expect(capture()).toContain("Make your connection bigger");
    expect(capture()).toMatchSnapshot();
  });

  it("state 12b — the pending panel: the descriptor's submitted copy, in the card", async () => {
    stub.getPendingChannels.mockResolvedValue([{ peer_pubkey: HUB_PUBKEY, status: "opening" }]);
    await renderDashboard();
    expect(capture()).toContain("Connection submitted");
    expect(capture()).toMatchSnapshot();
  });
});

// ─── Slice 2: behaviour ─────────────────────────────────────────────────────

/** The form's controls on the page: text inputs, radios, the connect button. */
function formParts() {
  return {
    inputs: host.querySelectorAll("input[type='text']").length,
    radios: host.querySelectorAll("input[type='radio']").length,
    connect: [...host.querySelectorAll("button")].filter((b) => b.textContent === "Connect to BitCorn →").length,
  };
}

describe("slice 2 — the amount box can be EMPTY", () => {
  it("select-all and delete leaves it empty, not 0; typing again works", async () => {
    await renderDashboard();
    await type(sizeBox(), "");
    expect(sizeBox().value).toBe("");
    expect(host.textContent).not.toContain("A connection must be at least");
    expect(btn("Connect to BitCorn →")!.disabled).toBe(true);
    // No size, so no summary line.
    expect(host.querySelector(".connect-summary")).toBeNull();
    await type(sizeBox(), "250000");
    expect(sizeBox().value).toBe((250_000).toLocaleString());
    expect(btn("Connect to BitCorn →")!.disabled).toBe(false);
  });
});

describe("slice 2 — upgrade mode has NO form", () => {
  it("a member with a connection: the heading, the current size in dollars over sats, and nothing to submit", async () => {
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    const [card, ...rest] = cards();
    expect(card, "the upgrade card renders").toBeDefined();
    expect(rest, "one card").toEqual([]);
    expect(card.textContent).toContain("Make your connection bigger");
    expect(card.textContent).toBe(
      "Make your connection bigger$600.001,000,000 satsA bigger connection lets you receive larger or more frequent payments before it fills up.",
    );
    expect(formParts(), "upgrade mode rendered form controls").toEqual({ inputs: 0, radios: 0, connect: 0 });
    expect(host.textContent).not.toContain("No hub channel");
    expect(host.textContent).not.toContain("Channel upgrade recommended");
    // The form's hook never mounted: no treasury-info read, no open.
    expect(stub.getTreasuryInfo).not.toHaveBeenCalled();
    expect(stub.openMemberChannel).not.toHaveBeenCalled();
  });

  it("control: with no connection, the same URL renders the form", async () => {
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    const f = formParts();
    expect(f.inputs).toBeGreaterThan(0);
    expect(f.radios).toBe(6);
    expect(f.connect).toBe(1);
  });
});

describe("slice 2 — the rate's four states", () => {
  const SENTENCE = "The bitcoin price isn't available right now, so amounts are shown in sats.";
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  const sizeLines = () =>
    [...host.querySelectorAll(".connect-sizes .amount")].map((a) =>
      [...a.querySelectorAll("[data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`).join(" / "));
  const summary = () => host.querySelector(".connect-summary")?.textContent;

  it("loading (undefined): sats alone, and no sentence anywhere", async () => {
    stub.getExchangeRate.mockImplementation(never);
    await renderDashboard();
    expect(sizeLines()[0]).toBe("sats:1,000,000 sats");
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Economy)}`);
    await click(feeCard("Normal")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Normal)}`);
    expect(count(host.textContent ?? "", SENTENCE)).toBe(0);
  });

  it("failed read (null): sats alone, and the page's sentence exactly once", async () => {
    stub.getExchangeRate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    await renderDashboard();
    expect(sizeLines()[0]).toBe("sats:1,000,000 sats");
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Economy)}`);
    await click(feeCard("Normal")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Normal)}`);
    expect(count(host.textContent ?? "", SENTENCE)).toBe(1);
    expect(cards()[0].textContent).not.toContain(SENTENCE);
  });

  it("no price (state none): sats alone, and the page's sentence exactly once", async () => {
    stub.getExchangeRate.mockResolvedValue({ usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" });
    await renderDashboard();
    expect(sizeLines()[0]).toBe("sats:1,000,000 sats");
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Economy)}`);
    await click(feeCard("Normal")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatSats(OPEN_SATS.Normal)}`);
    expect(count(host.textContent ?? "", SENTENCE)).toBe(1);
    expect(cards()[0].textContent).not.toContain(SENTENCE);
  });

  it("fresh: dollars with the sats under them, the box's dollars, the fee in dollars", async () => {
    stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
    await renderDashboard();
    expect(sizeLines()).toEqual([
      "usd:$600.00 / sats:1,000,000 sats",
      "usd:$3,000.00 / sats:5,000,000 sats",
      "usd:$6,000.00 / sats:10,000,000 sats",
    ]);
    expect(host.querySelector(".connect-box-usd")?.textContent).toBe("$600.00");
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatUsd(OPEN_SATS.Economy, 60_000).text}`);
    await click(feeCard("Normal")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatUsd(OPEN_SATS.Normal, 60_000).text}`);
    expect(count(host.textContent ?? "", SENTENCE)).toBe(0);
  });
});

// Rewritten for fee-estimates (was: ruling "a", 2026-11-16 — Economy sent no
// fee_rate, so its card and the footer said "set by your node" with no
// figure). Economy now sends its live rate (O2), so it shows its figure like
// the others; "Fee set by your node" is retired (MFRUI-ASKS (1)).
describe("fee-estimates — Economy has a live figure, like Normal and Priority", () => {
  const summary = () => host.querySelector(".connect-summary")?.textContent;
  const FRESH = { usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" };
  const meta = (label: "Economy" | "Normal" | "Priority") =>
    `about ${formatUsd(OPEN_SATS[label], 60_000).text}~${formatSats(OPEN_SATS[label])}`;

  it("each card: its live time and cost, dollars over sats (fresh rate); no \"set by your node\"", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await renderDashboard();
    const econ = feeCard("Economy")!;
    expect(econ, "the Economy card renders").toBeDefined();
    expect(econ.querySelector(".choice-meta")?.textContent).toBe(meta("Economy"));
    expect(econ.textContent).toBe(`Economy${timeText(FEES.options!.economy)}${meta("Economy")}`);
    expect(host.textContent).not.toContain("set by your node");
    expect(feeCard("Normal")!.querySelector(".choice-meta")?.textContent).toBe(meta("Normal"));
    expect(feeCard("Priority")!.querySelector(".choice-meta")?.textContent).toBe(meta("Priority"));
  });

  it("the footer: Economy (the default) gives its estimate; Normal its own; back to Economy", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await renderDashboard();
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatUsd(OPEN_SATS.Economy, 60_000).text}`);
    await click(feeCard("Normal")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatUsd(OPEN_SATS.Normal, 60_000).text}`);
    await click(feeCard("Economy")!);
    expect(summary()).toBe(`1,000,000 sats · network fee about ${formatUsd(OPEN_SATS.Economy, 60_000).text}`);
  });
});

describe("slice 2 — no \"channel\" or \"hub\" in the card's member text, in any state", () => {
  const WORDS = /channel|hub/i;
  /** The cards' text and every attribute a member can read or hear, Technical
   *  details included — and, since slice 5 (ruling (4)), the confirm dialog
   *  too (a portal on <body>, not in the card), Details included, its own
   *  aria-label with it. */
  function memberText(): string {
    const cs = cards();
    expect(cs.length, "no Connect card to check").toBeGreaterThanOrEqual(1);
    const dialog = document.body.querySelector('[role="dialog"]');
    const els = dialog ? [...cs, dialog] : cs;
    return els.map((c) => [
      c.textContent ?? "",
      ...[c, ...c.querySelectorAll("[aria-label],[placeholder],[title],[alt]")].flatMap((e) =>
        ["aria-label", "placeholder", "title", "alt"].map((a) => e.getAttribute(a) ?? "")),
    ].join(" | ")).join(" || ");
  }
  const openDialog = async () => { await click(btn("Connect to BitCorn →")!); };
  const LOCKED = {
    applicable: true, current_tier: "prepay", open_channel_allowed: false, treasury_signature: "verified",
  };

  const STATES: Array<[string, () => Promise<void>]> = [
    ["peered", async () => { stub.getMemberStats.mockResolvedValue({ ...CHANNEL_LESS, is_peered_to_hub: true }); await renderDashboard(); }],
    ["address known", async () => { stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET }); await renderDashboard(); }],
    ["checking", async () => { stub.getTreasuryInfo.mockImplementation(never); await renderDashboard(); }],
    ["not reachable: the address field in Technical details", async () => { await renderDashboard(); expect(addressBox()).not.toBeNull(); }],
    ["below the minimum", async () => { await renderDashboard(); await type(sizeBox(), "50000"); }],
    ["empty", async () => { await renderDashboard(); await type(sizeBox(), ""); }],
    ["locked", async () => { stub.getSubscriptionStatus.mockResolvedValue(LOCKED); await renderDashboard(); }],
    ["a failure with no message", async () => { stub.openMemberChannel.mockRejectedValue({}); await renderDashboard(); await openAndConfirm("1000000"); }],
    ["refused: membership not paid", async () => {
      stub.openMemberChannel.mockRejectedValue(Object.assign(new Error("membership_not_paid"), { status: 403, code: "membership_not_paid" }));
      await renderDashboard();
      await openAndConfirm("1000000");
    }],
    ["submitting", async () => { await renderDashboard(); await openAndConfirm("1000000"); }],
    // Slice 5: the confirm dialog itself, Details and its address included.
    ["the confirm dialog, auto-connect address", async () => {
      stub.getTreasuryInfo.mockResolvedValue({ pubkey: TREASURY_PUBKEY_FIXTURE, socket: HUB_SOCKET });
      await renderDashboard(); await openDialog();
    }],
    ["the confirm dialog, a typed address", async () => {
      await renderDashboard(); await type(addressBox(), "203.0.113.5:9735"); await openDialog();
    }],
    ["success with a txid", async () => { stub.openMemberChannel.mockResolvedValue({ funding_txid: "ab".repeat(32) }); await renderDashboard(); await openAndConfirm("1000000"); }],
    ["success, submitted", async () => { stub.openMemberChannel.mockResolvedValue({}); await renderDashboard(); await openAndConfirm("1000000"); }],
    ["pending", async () => { stub.getPendingChannels.mockResolvedValue([{ peer_pubkey: HUB_PUBKEY, status: "opening" }]); await renderDashboard(); }],
    ["upgrade", async () => { stub.getMemberStats.mockResolvedValue(WITH_CHANNEL); await renderDashboard("/dashboard?upgrade_capacity=5000000"); }],
  ];

  for (const [name, setup] of STATES) {
    it(name, async () => {
      await setup();
      const text = memberText();
      expect(text.match(WORDS), `"${text.match(WORDS)?.[0]}" in: ${text}`).toBeNull();
      // Slice 5: "BitCorn" is spelled so, the dialog included.
      expect(text).not.toContain("Bitcorn");
    });
  }

  it("not vacuous: with the dialog open the scan reads it, Details and the address included", async () => {
    await renderDashboard();
    await type(addressBox(), "203.0.113.5:9735");
    await openDialog();
    const text = memberText();
    expect(text).toContain("Connect to BitCorn");
    expect(text).toContain("The network fee is spent even if you close the connection later.");
    expect(text).toContain("203.0.113.5:9735");
    // …and the old dialog's words would be caught.
    expect("Open a channel to the hub").toMatch(WORDS);
    expect("Bitcorn treasury hub").toContain("Bitcorn");
  });
});

// ─── Ethan's ruling "fix the five" (2026-11-16), display only ────────────────
// What each option sends is pinned in ConnectToHub.feePins.test.tsx, unchanged.

describe("ruling \"fix the five\" — the member card", () => {
  const FRESH = { usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" };
  const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };
  /** A card's cost lines, "data-line:text", in order. */
  const costLines = (label: string) =>
    [...feeCard(label)!.querySelectorAll(".choice-meta [data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`);

  // Rewritten for fee-estimates: Economy's worded cost ("Fee set by your node")
  // is retired, so every card's cost is now an Amount figure; none is worded.
  it("2 — every card's cost is an Amount figure; no worded cost remains", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await renderDashboard();
    for (const label of ["Economy", "Normal", "Priority"]) {
      expect(feeCard(label)!.querySelector(".choice-meta .fee-cost-words"), label).toBeNull();
      expect(feeCard(label)!.querySelector(".choice-meta .amount"), label).not.toBeNull();
    }
  });

  it("3 — upgrade: the size is its own line under the heading (dollars over sats), then the sentence; no amount in a sentence", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    stub.getMemberStats.mockResolvedValue(WITH_CHANNEL);
    await renderDashboard("/dashboard?upgrade_capacity=5000000");
    const head = cards()[0].querySelector(".connect-head-text")!;
    const kids = [...head.children];
    expect(kids.map((k) => k.tagName)).toEqual(["H2", "DIV", "P"]);
    expect(kids[0].textContent).toBe("Make your connection bigger");
    const lines = [...kids[1].querySelectorAll("[data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`);
    expect(lines).toEqual(["usd:$600.00", "sats:1,000,000 sats"]);
    expect(kids[2].textContent).toBe("A bigger connection lets you receive larger or more frequent payments before it fills up.");
    expect(cards()[0].querySelectorAll("p .amount").length, "an amount inside a sentence").toBe(0);
  });

  // Rewritten for fee-estimates: Economy sends a live rate now, so Technical
  // details lists all three live rates (P19 (a)); was "Normal and Priority only".
  it("4 — Technical details lists the three live rates, Economy included (P19)", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await renderDashboard();
    const row = [...cards()[0].querySelectorAll("span")].find((e) => e.textContent === "Fee rates");
    expect(row, "the Fee rates row renders").toBeDefined();
    const o = FEES.options!;
    expect(row!.nextElementSibling?.textContent).toBe(
      `Economy ~${o.economy.rate} sat/vB · Normal ~${o.normal.rate} sat/vB · Priority ~${o.priority.rate} sat/vB`,
    );
  });

  // Rewritten for fee-estimates: Economy has a figure now ("keeps its words" retired).
  it("5 — the fee cards show dollars with the sats under them, Economy included", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await renderDashboard();
    for (const label of ["Economy", "Normal", "Priority"] as const) {
      expect(costLines(label)).toEqual([
        `usd:about ${formatUsd(OPEN_SATS[label], 60_000).text}`,
        `sats:~${formatSats(OPEN_SATS[label])}`,
      ]);
    }
  });

  it("5 — with no price, sats only", async () => {
    stub.getExchangeRate.mockResolvedValue(NONE);
    await renderDashboard();
    for (const label of ["Economy", "Normal", "Priority"] as const) {
      expect(costLines(label)).toEqual([`sats:~${formatSats(OPEN_SATS[label])}`]);
    }
  });
});
