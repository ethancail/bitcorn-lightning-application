// The treasury's two fee pickers decide what the treasury pays: the close-channel
// dialog's on-chain fee rate (ChannelsPage) and the open-channel panel's
// confirmation speed (TreasuryOpenChannelPanel). Orchestrator addendum 1,
// 2026-11-13: converting them to Choice must change NO option's value, default
// or label, so this file pins all three, with the values develop (0536e70)
// shipped:
//   - label: each option's whole text, in order;
//   - default: Economy is the checked option, and an untouched form sends Economy's rate;
//   - value: choosing each option sends exactly its rate.
// develop 156b0e3 ships the same values as 0536e70 (App.tsx is unchanged between).
// One deliberate text change, ruled 2026-11-13 (3b): on both cards the cost
// is its own line, so the close dialog's "1–3 hours · ~192 sats" is now two
// lines and its " · " joiner is gone; every label, value and default stays.
// The rate is read off the treasuryCloseChannel / treasuryOpenChannel call —
// what is actually sent. Economy differs between the two on develop and stays
// so: the close sends `fee_rate: undefined`, the open leaves fee_rate out.
//
// Ethan's ruling "treasury too" (2026-11-16), the member card's ruling "a"
// applied here: Economy sends no rate, so the node sets its fee and nothing
// computes "~192 sats" or "~155 sats"; on both pickers Economy's cost line now
// reads "Fee set by your node". CLOSE_PINNED and OPEN_PINNED are still
// byte-identical — every key, rate and default they pin is what is sent,
// unchanged — and their Economy `text`/`cost` stay develop's, as the record of
// what shipped. The label and cost-line tests compare Economy against the
// ruled text below, the others against the pins.
//
// Ethan's ruling "fix the five" (2026-11-16), display only: the close card's
// Economy drops its rate "~1 sat/vB" (item 4), so CLOSE_ECONOMY_TEXT loses it;
// and each figure is now "about $X" over "~N sats" (item 5). The pins hold as
// they are because these tests read with the price still loading, when a
// figure is "~N sats" alone, exactly the pinned text. The rulings' own tests
// are at the end of this file. The pins are byte-identical.
//
// Harness: App.treasuryCapacity.test.tsx's (the REAL App, as the treasury).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { declsFor } from "./styleRules.testutil";

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
  getContacts: vi.fn(),
  getPendingChannels: vi.fn(),
  getExchangeRate: vi.fn(),
  treasuryCloseChannel: vi.fn(),
  treasuryOpenChannel: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

const pk = (c: string) => "02" + c.repeat(64);
const MERCHANT = pk("b");
const CHANNELS = [
  { channel_id: "1", peer_pubkey: MERCHANT, capacity_sat: 2_000_000, local_balance_sat: 1_000_000, remote_balance_sat: 1_000_000, active: 1 },
];
const CONTACTS = [{ pubkey: MERCHANT, name: "Merchant1", tags: ["merchant"] }];

/** develop's close-dialog options, in order; the cost on its own line (3b). */
const CLOSE_PINNED = [
  { label: "Economy", text: "Economy~1 sat/vB1–3 hours~192 sats", cost: "~192 sats", key: "economy", rate: undefined },
  { label: "Normal", text: "Normal~5 sat/vB~30 min~960 sats", cost: "~960 sats", key: "normal", rate: 5 },
  { label: "Priority", text: "Priority~15 sat/vB~10 min~2,885 sats", cost: "~2,885 sats", key: "priority", rate: 15 },
] as const;

/** develop's open-panel options, in order; the cost on its own line (3b). */
const OPEN_PINNED = [
  { label: "Economy", text: "Economy1–3 hours~155 sats", cost: "~155 sats", key: "economy", rate: undefined },
  { label: "Normal", text: "Normal~30 min~770 sats", cost: "~770 sats", key: "normal", rate: 5 },
  { label: "Priority", text: "Priority~10 min~2,300 sats", cost: "~2,300 sats", key: "priority", rate: 15 },
] as const;

/** Economy's card since "treasury too" (2026-11-16): the node sets its fee. */
const ECONOMY_COST = "Fee set by your node";
const CLOSE_ECONOMY_TEXT = "Economy1–3 hoursFee set by your node";
const OPEN_ECONOMY_TEXT = "Economy1–3 hoursFee set by your node";
type Pin = { key: string; text: string; cost: string };
const shownText = (pins: readonly Pin[], economy: string) => pins.map((p) => (p.key === "economy" ? economy : p.text));
const shownCost = (pins: readonly Pin[]) => pins.map((p) => [p.key === "economy" ? ECONOMY_COST : p.cost]);

/** Each card's cost line: exactly one .choice-cost (the line that never splits), holding the cost alone. */
const costLines = (opts: HTMLElement[]) =>
  opts.map((o) => [...o.querySelectorAll(".choice-cost")].map((c) => c.textContent));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: null, bitcorn_name_set_at: null });
  stub.getProfileAlias.mockImplementation(never);
  stub.getSubscriptionStatus.mockImplementation(never);
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoBuyAlertBadge.mockResolvedValue({ active_count: 0, highest_severity: null });
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
  stub.getMemberLiquidityStatus.mockImplementation(never);
  stub.getContacts.mockResolvedValue(CONTACTS);
  stub.getPendingChannels.mockResolvedValue([]);
  stub.getExchangeRate.mockImplementation(never); // the price still loading: figures in sats alone
  stub.treasuryCloseChannel.mockImplementation(never);
  stub.treasuryOpenChannel.mockImplementation(never);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/api/channels") ? CHANNELS : []),
  })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  for (const c of [...document.body.children]) c.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderChannels() {
  stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "lnd-alias", pubkey: pk("a"), synced_to_chain: true });
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/channels");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  await flush();
  return host;
}

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

const buttons = (scope: ParentNode = document.body) => [...scope.querySelectorAll("button")] as HTMLButtonElement[];
const labelOf = (o: Element) => o.querySelector(".choice-label")?.textContent;
const checkedLabels = (opts: HTMLElement[]) => opts.filter((o) => o.querySelector("input")?.checked).map(labelOf);

/** The option cards after a heading with this exact text, inside `scope`. */
function optionsAfter(scope: ParentNode, heading: string): HTMLElement[] {
  const head = [...scope.querySelectorAll("div, label")].find((e) => e.textContent?.trim() === heading && e.children.length === 0);
  expect(head, `the ${heading} heading renders`).toBeDefined();
  return [...head!.nextElementSibling!.querySelectorAll<HTMLElement>("label")];
}

async function choose(opts: () => HTMLElement[], label: string) {
  await click(opts().find((o) => labelOf(o) === label)!);
}

// ─── ChannelsPage: the close-channel dialog ────────────────────────────────

const dialog = () => document.body.querySelector(".dialog-card") as HTMLElement;
const closeOptions = () => optionsAfter(dialog(), "On-chain fee rate");

async function openCloseDialog() {
  const el = await renderChannels();
  const closeBtn = buttons(el).find((b) => b.textContent?.trim() === "Close");
  expect(closeBtn, "the lane's Close button renders").toBeDefined();
  await click(closeBtn!);
  expect(dialog(), "the close dialog opens").not.toBeNull();
}

async function confirmClose(): Promise<Record<string, unknown>> {
  await type(dialog().querySelector("#close-channel-challenge") as HTMLInputElement, "CLOSE");
  const confirm = buttons(dialog()).find((b) => b.textContent?.trim() === "Close Channel" && b.className.includes("btn-danger"));
  expect(confirm!.disabled).toBe(false);
  await click(confirm!);
  expect(stub.treasuryCloseChannel).toHaveBeenCalledTimes(1);
  return stub.treasuryCloseChannel.mock.calls[0][0];
}

describe("ChannelsPage close-channel fee picker: values, default and labels unchanged", () => {
  it("label: three options, each with develop's exact text (Economy's as ruled), in order", async () => {
    await openCloseDialog();
    expect(closeOptions().map((o) => o.textContent)).toEqual(shownText(CLOSE_PINNED, CLOSE_ECONOMY_TEXT));
  });

  it("the cost is its own line: one .choice-cost per card, the cost alone", async () => {
    await openCloseDialog();
    expect(costLines(closeOptions())).toEqual(shownCost(CLOSE_PINNED));
  });

  it("the radios carry the ruled string keys", async () => {
    await openCloseDialog();
    expect(closeOptions().map((o) => o.querySelector("input")?.value)).toEqual(CLOSE_PINNED.map((p) => p.key));
  });

  it("default: Economy is the one checked option, and an untouched dialog sends fee_rate undefined", async () => {
    await openCloseDialog();
    expect(checkedLabels(closeOptions())).toEqual(["Economy"]);
    const body = await confirmClose();
    expect(body).toHaveProperty("fee_rate", undefined);
    expect(body.channel_id).toBe("1");
  });

  for (const p of CLOSE_PINNED) {
    it(`value: choosing ${p.label} sends fee_rate ${String(p.rate)}`, async () => {
      await openCloseDialog();
      const other = CLOSE_PINNED.find((q) => q.label !== p.label)!;
      await choose(closeOptions, other.label);
      await choose(closeOptions, p.label);
      expect(checkedLabels(closeOptions())).toEqual([p.label]);
      const body = await confirmClose();
      expect(body.fee_rate).toBe(p.rate);
    });
  }
});

// ─── TreasuryOpenChannelPanel ──────────────────────────────────────────────

const openPanel = () =>
  [...document.body.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent?.includes("Open Channel")) as HTMLElement;
const openOptions = () => optionsAfter(openPanel(), "Confirmation Speed");

async function showOpenForm() {
  await renderChannels();
  expect(openPanel(), "the treasury's Open Channel panel renders").toBeDefined();
  await click(buttons(openPanel()).find((b) => b.textContent?.trim() === "New Channel")!);
  await click(buttons(openPanel()).find((b) => b.textContent?.includes("Merchant1"))!);
}

async function confirmOpen(): Promise<Record<string, unknown>> {
  await click(buttons(openPanel()).find((b) => b.textContent?.startsWith("Open 5,000,000 sat channel"))!);
  await type(document.body.querySelector("#action-confirm-challenge") as HTMLInputElement, "5000000");
  await click(buttons().find((b) => b.textContent?.trim() === "Open channel")!);
  expect(stub.treasuryOpenChannel).toHaveBeenCalledTimes(1);
  return stub.treasuryOpenChannel.mock.calls[0][0];
}

describe("TreasuryOpenChannelPanel fee picker: values, default and labels unchanged", () => {
  it("label: three options, each with develop's exact text (Economy's as ruled), in order", async () => {
    await showOpenForm();
    expect(openOptions().map((o) => o.textContent)).toEqual(shownText(OPEN_PINNED, OPEN_ECONOMY_TEXT));
  });

  it("the cost is its own line: one .choice-cost per card, the cost alone", async () => {
    await showOpenForm();
    expect(costLines(openOptions())).toEqual(shownCost(OPEN_PINNED));
  });

  it("the radios carry the ruled string keys", async () => {
    await showOpenForm();
    expect(openOptions().map((o) => o.querySelector("input")?.value)).toEqual(OPEN_PINNED.map((p) => p.key));
  });

  it("default: Economy is the one checked option, and an untouched form sends no fee_rate", async () => {
    await showOpenForm();
    expect(checkedLabels(openOptions())).toEqual(["Economy"]);
    const body = await confirmOpen();
    expect(body).not.toHaveProperty("fee_rate");
    expect(body).toMatchObject({ peer_pubkey: MERCHANT, capacity_sats: 5_000_000 });
  });

  for (const p of OPEN_PINNED) {
    it(`value: choosing ${p.label} sends fee_rate ${String(p.rate)}`, async () => {
      await showOpenForm();
      const other = OPEN_PINNED.find((q) => q.label !== p.label)!;
      await choose(openOptions, other.label);
      await choose(openOptions, p.label);
      expect(checkedLabels(openOptions())).toEqual([p.label]);
      const body = await confirmOpen();
      expect(body.fee_rate).toBe(p.rate);
    });
  }
});

// ─── "treasury too" (2026-11-16): Economy shows no figure on either picker ──

describe("ruling \"treasury too\" — Economy's fee is set by the node: no figure", () => {
  // No "~N sats" and no dollars on Economy's card. (Its rate "~1 sat/vB" went
  // too, with "fix the five" item 4: tested below.)
  const NO_FIGURE = /~[\d,]+ sats|\$/;
  const economy = (opts: HTMLElement[]) => opts.find((o) => labelOf(o) === "Economy")!;

  it("the close dialog: Economy's cost line reads \"Fee set by your node\", no ~N sats or $", async () => {
    await openCloseDialog();
    const card = economy(closeOptions());
    expect(card.querySelector(".choice-cost")?.textContent).toBe(ECONOMY_COST);
    expect(card.textContent).not.toMatch(NO_FIGURE);
    expect(card.textContent).not.toContain("~192 sats");
  });

  it("the open panel: Economy's cost line reads \"Fee set by your node\", no ~ or $", async () => {
    await showOpenForm();
    const card = economy(openOptions());
    expect(card.querySelector(".choice-cost")?.textContent).toBe(ECONOMY_COST);
    expect(card.textContent).not.toMatch(/[~$]/);
    expect(card.textContent).not.toContain("~155 sats");
  });
});

// ─── The cost line never splits (3b) ──────────────────────────────────────

describe("Choice's cost line", () => {
  it("is white-space: nowrap, so \"~192 sats\" never breaks across two lines", () => {
    expect(declsFor(".choice-cost")["white-space"]).toBe("nowrap");
  });
});

// ─── Ethan's ruling "fix the five" (2026-11-16), display only ────────────────
// What each picker sends is pinned above, unchanged.

describe("ruling \"fix the five\" — the treasury's two fee pickers", () => {
  const FRESH = { usd: 60_000, source: "coinbase", fetched_at: 1_790_000_000_000, age_ms: 0, state: "fresh" };
  const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };
  const card = (opts: HTMLElement[], label: string) => opts.find((o) => labelOf(o) === label)!;
  /** A card's cost lines, "data-line:text", in order. */
  const lines = (opts: HTMLElement[], label: string) =>
    [...card(opts, label).querySelectorAll(".choice-cost [data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`);

  it("1 — a worded cost may wrap, numbers stay on one line (the CSS)", () => {
    expect(declsFor(".choice-cost")["white-space"]).toBe("nowrap");
    expect(declsFor(".fee-cost-words")["white-space"]).toBe("normal");
    // Wraps cleanly: balanced lines, which need a block to balance.
    expect(declsFor(".fee-cost-words")["text-wrap"]).toBe("balance");
    expect(declsFor(".fee-cost-words")["display"]).toBe("block");
    expect(declsFor(".amount-figure")["white-space"]).toBe("nowrap");
    expect(declsFor(".amount-sub")["white-space"]).toBe("nowrap");
  });

  for (const [name, show, opts] of [
    ["the close dialog", openCloseDialog, closeOptions],
    ["the open panel", showOpenForm, openOptions],
  ] as const) {
    it(`1 — ${name}: Economy's words are in .fee-cost-words; the figures are Amounts`, async () => {
      stub.getExchangeRate.mockResolvedValue(FRESH);
      await show();
      expect(card(opts(), "Economy").querySelector(".choice-cost .fee-cost-words")?.textContent).toBe("Fee set by your node");
      for (const label of ["Normal", "Priority"]) {
        expect(card(opts(), label).querySelector(".choice-cost .fee-cost-words"), label).toBeNull();
        expect(card(opts(), label).querySelector(".choice-cost .amount"), label).not.toBeNull();
      }
    });
  }

  it("4 — the close dialog: Economy shows no rate; Normal and Priority keep theirs", async () => {
    await openCloseDialog();
    const econ = card(closeOptions(), "Economy");
    expect(econ.textContent).not.toContain("sat/vB");
    expect(econ.querySelector(".choice-desc")).toBeNull();
    expect(card(closeOptions(), "Normal").querySelector(".choice-desc")?.textContent).toBe("~5 sat/vB");
    expect(card(closeOptions(), "Priority").querySelector(".choice-desc")?.textContent).toBe("~15 sat/vB");
    expect(dialog().textContent).not.toContain("1 sat/vB");
  });

  it("5 — the close dialog: dollars over sats; Economy keeps its words", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await openCloseDialog();
    expect(lines(closeOptions(), "Normal")).toEqual(["usd:about $0.58", "sats:~960 sats"]);
    expect(lines(closeOptions(), "Priority")).toEqual(["usd:about $1.73", "sats:~2,885 sats"]);
    expect(lines(closeOptions(), "Economy")).toEqual([]);
    expect(card(closeOptions(), "Economy").querySelector(".choice-cost")?.textContent).toBe(ECONOMY_COST);
  });

  it("5 — the open panel: dollars over sats; Economy keeps its words", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await showOpenForm();
    expect(lines(openOptions(), "Normal")).toEqual(["usd:about $0.46", "sats:~770 sats"]);
    expect(lines(openOptions(), "Priority")).toEqual(["usd:about $1.38", "sats:~2,300 sats"]);
    expect(lines(openOptions(), "Economy")).toEqual([]);
    expect(card(openOptions(), "Economy").querySelector(".choice-cost")?.textContent).toBe(ECONOMY_COST);
  });

  for (const [why, setRate] of [
    ["no price (state none)", () => stub.getExchangeRate.mockResolvedValue(NONE)],
    ["a failed read", () => stub.getExchangeRate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ] as const) {
    it(`5 — ${why}: sats only, on both pickers`, async () => {
      setRate();
      await openCloseDialog();
      expect(lines(closeOptions(), "Normal")).toEqual(["sats:~960 sats"]);
      expect(lines(closeOptions(), "Priority")).toEqual(["sats:~2,885 sats"]);
      await click(buttons(dialog()).find((b) => b.textContent?.trim() === "Cancel")!);
      await click(buttons(openPanel()).find((b) => b.textContent?.trim() === "New Channel")!);
      expect(lines(openOptions(), "Normal")).toEqual(["sats:~770 sats"]);
      expect(lines(openOptions(), "Priority")).toEqual(["sats:~2,300 sats"]);
    });
  }
});
