// The treasury's two fee pickers decide what the treasury pays: the close-channel
// dialog's fee rate (ChannelsPage) and the open-channel panel's confirmation
// speed (TreasuryOpenChannelPanel). This file pins each one's labels, keys,
// default, value sent and cost line (orchestrator addendum 1, 2026-11-13).
//
// REWRITTEN DELIBERATELY for fee-estimates (spec §13 items 2, 8 and 9;
// MFRUI-ASKS (2)), never deleted. Until 2026-11-18 it pinned develop 0536e70's
// FIXED options in CLOSE_PINNED and OPEN_PINNED — Economy sending no rate
// (`fee_rate: undefined` on the close, the key left out on the open), Normal 5,
// Priority 15 — and "Fee set by your node" on Economy (rulings "treasury too"
// and "fix the five", 2026-11-16). Under O2 those pins go red, correctly:
// every option, Economy included, now sends the live integer it shows. The
// subjects are kept (label, key, default, value sent, cost line; Choice's
// nowrap cost line; FeeCost's dollars-over-sats), and every expectation is
// DERIVED FROM THE STUBBED /api/fee-estimates answer (H1).
//
// Opens and closes pin different things (§13 item 9, R2): sent = shown for the
// open panel; PROPOSED = shown for the close dialog, whose rate is an offer to
// the peer — labelled "proposed to the peer", its cost "about $X proposed — the
// final fee is often higher" (ruling 4 of member-first-run-ui's review,
// 2026-11-18). REWRITTEN DELIBERATELY: until then every close-cost pin below
// read "about $X, if accepted" / "~N sats, if accepted". The ruled words are
// pinned as a literal (PROPOSED), not read back from FEE_COPY, so a copy edit
// goes red here.
//
// Also here: H2, H3 (the 10-min bound at confirm), H4, H6 (unavailable), the
// option key with tied rates and its reset (F3), the 200 ceiling (P15), the
// confirm summaries' rate rows equal to the hashed rate (CONFIRM-RULING), the
// D6 "too low" copy on both cards, the depth copy (F5), and the close
// dialog's frozen figure (Ethan, 2026-11-18).
//
// Harness: App.treasuryCapacity.test.tsx's (the REAL App, as the treasury).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { declsFor } from "./styleRules.testutil";
import type { FeeEstimates } from "./api/client";
import { feeEstimatesStub, UNAVAILABLE } from "./components/fees/feeEstimates.testutil";
import { FEE_COPY, REFRESH_INTERVAL_MS, timeText } from "./components/fees/feeEstimatesDescriptor";
import { formatSats, formatUsd } from "./components/amount/amountDescriptor";
import { confirmationFor, findUiConfirmedRoute } from "./api/actionConfirmation";
import App from "./App";

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
  getFeeEstimates: vi.fn(),
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

/** The stub every pin derives from. Distinct rates, so each option is told apart. */
const STUB = feeEstimatesStub({ economy: 2, normal: 4, priority: 9 });
const KEYS = ["economy", "normal", "priority"] as const;
const LABELS = ["Economy", "Normal", "Priority"] as const;

/** The close cost's qualifier, as ruled (ruling 4, 2026-11-18). */
const PROPOSED = "proposed — the final fee is often higher";
/** Close card text, price still loading: label, rate, time, "~N sats proposed — …". */
const closeText = (est: FeeEstimates, i: number) => {
  const o = est.options![KEYS[i]];
  return `${LABELS[i]}~${o.rate} sat/vB${timeText(o)}~${formatSats(o.cost_sats.close)} ${PROPOSED}`;
};
/** Open card text, price still loading: label, rate, time, "~N sats".
 *  REWRITTEN DELIBERATELY (member-first-run-ui's review, ruling 2, relayed
 *  2026-11-18): until then the open card read label, time, cost, with no
 *  rate; it now shows the rate as the close card does. */
const openText = (est: FeeEstimates, i: number) => {
  const o = est.options![KEYS[i]];
  return `${LABELS[i]}~${o.rate} sat/vB${timeText(o)}~${formatSats(o.cost_sats.open)}`;
};

/** Each card's cost line: exactly one .choice-cost (the line that never splits). */
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
  stub.getFeeEstimates.mockResolvedValue(STUB);
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
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderChannels() {
  stub.getNode.mockResolvedValue({ node_role: "treasury", alias: "lnd-alias", pubkey: pk("a"), synced_to_chain: true });
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
const closeOptions = () => optionsAfter(dialog(), FEE_COPY.closeRateHeading);
const closeButton = () => buttons(dialog()).find((b) => b.textContent?.trim() === "Close Channel" && b.className.includes("btn-danger"))!;
const closeSummaryLine = () => dialog().querySelector(".close-fee-summary")?.textContent;

async function openCloseDialog() {
  const el = await renderChannels();
  const closeBtn = buttons(el).find((b) => b.textContent?.trim() === "Close");
  expect(closeBtn, "the lane's Close button renders").toBeDefined();
  await click(closeBtn!);
  expect(dialog(), "the close dialog opens").not.toBeNull();
}

async function clickClose() {
  await type(dialog().querySelector("#close-channel-challenge") as HTMLInputElement, "CLOSE");
  expect(closeButton().disabled).toBe(false);
  await click(closeButton());
}

async function confirmClose(): Promise<Record<string, unknown>> {
  await clickClose();
  expect(stub.treasuryCloseChannel).toHaveBeenCalledTimes(1);
  return stub.treasuryCloseChannel.mock.calls[0][0];
}

describe("ChannelsPage close dialog: live labels, keys, default and proposed rates (H1, H2, H4; R2)", () => {
  it("the heading says the rate is proposed to the peer (R2)", async () => {
    await openCloseDialog();
    expect(closeOptions()).toHaveLength(3);
  });

  it("label (H1): three options, each card's text derived from the stub, in order", async () => {
    await openCloseDialog();
    expect(closeOptions().map((o) => o.textContent)).toEqual([0, 1, 2].map((i) => closeText(STUB, i)));
  });

  it("the cost is its own line: one .choice-cost per card, \"~N sats proposed — the final fee is often higher\"", async () => {
    await openCloseDialog();
    expect(costLines(closeOptions())).toEqual(
      KEYS.map((k) => [`~${formatSats(STUB.options![k].cost_sats.close)} ${PROPOSED}`]),
    );
    expect(dialog().textContent).not.toContain("if accepted");
  });

  it("the radios carry the ruled string keys", async () => {
    await openCloseDialog();
    expect(closeOptions().map((o) => o.querySelector("input")?.value)).toEqual([...KEYS]);
  });

  it("default (H4): Economy is checked, and an untouched dialog proposes Economy's shown rate", async () => {
    await openCloseDialog();
    expect(checkedLabels(closeOptions())).toEqual(["Economy"]);
    const body = await confirmClose();
    expect(body.fee_rate).toBe(STUB.options!.economy.rate);
    expect(body.channel_id).toBe("1");
    expect(body).not.toHaveProperty("is_force_close");
  });

  KEYS.forEach((key, i) => {
    it(`value (H2, proposed = shown): choosing ${LABELS[i]} proposes its shown rate`, async () => {
      await openCloseDialog();
      await choose(closeOptions, LABELS[(i + 1) % 3]);
      await choose(closeOptions, LABELS[i]);
      expect(checkedLabels(closeOptions())).toEqual([LABELS[i]]);
      const card = closeOptions().find((o) => labelOf(o) === LABELS[i])!;
      expect(card.querySelector(".choice-desc")?.textContent).toBe(`~${STUB.options![key].rate} sat/vB`);
      const body = await confirmClose();
      expect(body.fee_rate).toBe(STUB.options![key].rate);
    });
  });

  it("states who pays (R3, interim): \"paid by whoever opened the channel\"", async () => {
    await openCloseDialog();
    expect(dialog().textContent).toContain(FEE_COPY.closePayer);
  });
});

describe("the close dialog's \"Fee rate proposed\" row equals the hashed rate (CONFIRM-RULING)", () => {
  KEYS.forEach((key, i) => {
    it(`${LABELS[i]}: the row shows the rate the request carries and the confirmation hashes`, async () => {
      await openCloseDialog();
      await choose(closeOptions, LABELS[(i + 1) % 3]);
      await choose(closeOptions, LABELS[i]);
      expect(closeSummaryLine()).toBe(`Fee rate proposed: ${LABELS[i]}, ~${STUB.options![key].rate} sat/vB`);
      const rowRate = Number(/~(\d+) sat\/vB/.exec(closeSummaryLine()!)![1]);
      const body = await confirmClose();
      const url = "/api/treasury/rotation/execute";
      const d = confirmationFor(findUiConfirmedRoute("POST", url)!, url, JSON.stringify(body));
      expect(d.ok).toBe(true);
      expect(body.fee_rate).toBe(rowRate);
      if (d.ok) expect(d.canonical).toContain(`fee_rate=${rowRate}`);
    });
  });
});

// ─── TreasuryOpenChannelPanel ──────────────────────────────────────────────

const openPanel = () =>
  [...document.body.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent?.includes("Open Channel")) as HTMLElement;
const openOptions = () => optionsAfter(openPanel(), "Confirmation Speed");
const openSubmit = () => buttons(openPanel()).find((b) => b.textContent?.startsWith("Open 5,000,000 sat channel"))!;

/** The confirm modal's "Fee rate" row value. */
function feeRateRow(): string | undefined {
  const dts = [...document.body.querySelectorAll(".dialog-card dt")];
  return dts.find((d) => d.textContent === "Fee rate")?.nextElementSibling?.textContent ?? undefined;
}

async function showOpenForm() {
  await renderChannels();
  expect(openPanel(), "the treasury's Open Channel panel renders").toBeDefined();
  await click(buttons(openPanel()).find((b) => b.textContent?.trim() === "New Channel")!);
  await click(buttons(openPanel()).find((b) => b.textContent?.includes("Merchant1"))!);
}

async function openOpenModal() {
  await click(openSubmit());
}

async function confirmOpenModal() {
  await type(document.body.querySelector("#action-confirm-challenge") as HTMLInputElement, "5000000");
  await click(buttons().find((b) => b.textContent?.trim() === "Open channel")!);
}

async function confirmOpen(): Promise<Record<string, unknown>> {
  await openOpenModal();
  await confirmOpenModal();
  expect(stub.treasuryOpenChannel).toHaveBeenCalledTimes(1);
  return stub.treasuryOpenChannel.mock.calls[0][0];
}

describe("TreasuryOpenChannelPanel: live labels, keys, default and values (H1, H2, H4)", () => {
  it("label (H1): three options, each card's text derived from the stub, in order", async () => {
    await showOpenForm();
    expect(openOptions().map((o) => o.textContent)).toEqual([0, 1, 2].map((i) => openText(STUB, i)));
  });

  // Ruling 2 (2026-11-18): the open card shows its sat/vB rate, matching the
  // close dialog — the rate the card sends, in the same slots (.choice-desc
  // the rate, .choice-meta the time).
  it("each card shows its rate, \"~N sat/vB\", then its time — the close dialog's layout", async () => {
    const slots = (opts: HTMLElement[]) =>
      opts.map((o) => [o.querySelector(".choice-desc")?.textContent, o.querySelector(".choice-meta")?.textContent]);
    const expected = KEYS.map((k) => [`~${STUB.options![k].rate} sat/vB`, timeText(STUB.options![k])]);
    await openCloseDialog();
    expect(slots(closeOptions()), "the close dialog: rate, then time").toEqual(expected);
    await click(buttons(dialog()).find((b) => b.textContent?.trim() === "Cancel")!);
    await click(buttons(openPanel()).find((b) => b.textContent?.trim() === "New Channel")!);
    await click(buttons(openPanel()).find((b) => b.textContent?.includes("Merchant1"))!);
    expect(slots(openOptions()), "the open panel: the same rate, then time").toEqual(expected);
  });

  it("the cost is its own line: one .choice-cost per card, the cost alone", async () => {
    await showOpenForm();
    expect(costLines(openOptions())).toEqual(KEYS.map((k) => [`~${formatSats(STUB.options![k].cost_sats.open)}`]));
  });

  it("the radios carry the ruled string keys", async () => {
    await showOpenForm();
    expect(openOptions().map((o) => o.querySelector("input")?.value)).toEqual([...KEYS]);
  });

  it("default (H4): Economy is checked, and an untouched form sends Economy's shown rate", async () => {
    await showOpenForm();
    expect(checkedLabels(openOptions())).toEqual(["Economy"]);
    const body = await confirmOpen();
    expect(body.fee_rate).toBe(STUB.options!.economy.rate);
    expect(body).toMatchObject({ peer_pubkey: MERCHANT, capacity_sats: 5_000_000 });
  });

  KEYS.forEach((key, i) => {
    it(`value (H2, sent = shown): choosing ${LABELS[i]} sends its shown rate`, async () => {
      await showOpenForm();
      await choose(openOptions, LABELS[(i + 1) % 3]);
      await choose(openOptions, LABELS[i]);
      expect(checkedLabels(openOptions())).toEqual([LABELS[i]]);
      const body = await confirmOpen();
      expect(body.fee_rate).toBe(STUB.options![key].rate);
    });
  });
});

describe("the open summary's \"Fee rate\" row equals the hashed rate (CONFIRM-RULING)", () => {
  KEYS.forEach((key, i) => {
    it(`${LABELS[i]}: the row shows the rate the request carries and the confirmation hashes`, async () => {
      await showOpenForm();
      await choose(openOptions, LABELS[(i + 1) % 3]);
      await choose(openOptions, LABELS[i]);
      await openOpenModal();
      expect(feeRateRow()).toBe(`${LABELS[i]}, ~${STUB.options![key].rate} sat/vB`);
      const rowRate = Number(/~(\d+) sat\/vB/.exec(feeRateRow()!)![1]);
      await confirmOpenModal();
      const body = stub.treasuryOpenChannel.mock.calls[0][0];
      const url = "/api/treasury/expansion/execute";
      const d = confirmationFor(findUiConfirmedRoute("POST", url)!, url, JSON.stringify(body));
      expect(d.ok).toBe(true);
      expect(body.fee_rate).toBe(rowRate);
      if (d.ok) expect(d.canonical).toContain(`fee_rate=${rowRate}`);
    });
  });
});

// ─── H3: the 10-min bound at confirm (O6, P18) ──────────────────────────────

describe("H3 — the 10-min bound at confirm, on both treasury cards", () => {
  const T0 = Date.parse("2026-11-18T12:00:00.000Z");
  const LATER = feeEstimatesStub({ economy: 3, normal: 6, priority: 12 });

  it("close, under the bound: the shown rate is proposed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await openCloseDialog();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 9 * 60_000);
    const body = await confirmClose();
    expect(body.fee_rate).toBe(STUB.options!.economy.rate);
  });

  it("close, over the bound: refreshed, re-shown, the word cleared, NOTHING sent until confirmed again", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await openCloseDialog();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 11 * 60_000);
    await clickClose();
    expect(stub.treasuryCloseChannel).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain(FEE_COPY.refreshed);
    expect((dialog().querySelector("#close-channel-challenge") as HTMLInputElement).value).toBe("");
    expect(closeSummaryLine()).toBe(`Fee rate proposed: Economy, ~${LATER.options!.economy.rate} sat/vB`);
    const body = await confirmClose();
    expect(body.fee_rate).toBe(LATER.options!.economy.rate);
  });

  it("open, under the bound: the shown rate is sent", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await showOpenForm();
    await openOpenModal();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 9 * 60_000);
    await confirmOpenModal();
    expect(stub.treasuryOpenChannel.mock.calls[0][0].fee_rate).toBe(STUB.options!.economy.rate);
  });

  it("open, over the bound: refreshed, re-shown, NOTHING sent until the new figure is confirmed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await showOpenForm();
    await openOpenModal();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 11 * 60_000);
    await confirmOpenModal();
    expect(stub.treasuryOpenChannel).not.toHaveBeenCalled();
    expect(feeRateRow()).toBe(`Economy, ~${LATER.options!.economy.rate} sat/vB`);
    expect(document.body.textContent).toContain(FEE_COPY.refreshed);
    await confirmOpenModal();
    expect(stub.treasuryOpenChannel).toHaveBeenCalledTimes(1);
    expect(stub.treasuryOpenChannel.mock.calls[0][0].fee_rate).toBe(LATER.options!.economy.rate);
  });
});

// ─── H6: unavailable (O7) ────────────────────────────────────────────────────

describe("H6 — unavailable: no number, nothing sent", () => {
  for (const [why, setUp] of [
    ["the API answers unavailable", () => stub.getFeeEstimates.mockResolvedValue(UNAVAILABLE)],
    ["the read fails", () => stub.getFeeEstimates.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ] as const) {
    it(`close dialog, ${why}: "Fee estimate unavailable", no figure, Close blocked`, async () => {
      setUp();
      await openCloseDialog();
      const area = dialog().querySelector("#close-fee-rate-label")!.parentElement!;
      expect(area.textContent).toContain(FEE_COPY.unavailable);
      expect(area.textContent).not.toMatch(/sat\/vB|~|\$/);
      expect(area.querySelectorAll("input[type=radio]")).toHaveLength(0);
      await type(dialog().querySelector("#close-channel-challenge") as HTMLInputElement, "CLOSE");
      expect(closeButton().disabled).toBe(true);
      await click(closeButton());
      expect(stub.treasuryCloseChannel).not.toHaveBeenCalled();
    });

    it(`open panel, ${why}: "Fee estimate unavailable", no figure, submit blocked`, async () => {
      setUp();
      await showOpenForm();
      expect(openPanel().textContent).toContain(FEE_COPY.unavailable);
      expect(openPanel().querySelectorAll('input[name="treasury-open-fee"]')).toHaveLength(0);
      expect(openSubmit().disabled).toBe(true);
      await click(openSubmit());
      expect(document.body.querySelector("#action-confirm-challenge")).toBeNull();
      expect(stub.treasuryOpenChannel).not.toHaveBeenCalled();
    });
  }
});

// ─── F3: the option key ──────────────────────────────────────────────────────

describe("F3 — the option key: tied rates, and the reset is to Economy", () => {
  const TIED = feeEstimatesStub({ economy: 1, normal: 1, priority: 2 });

  it("close: Normal and Economy tie; choosing Normal keeps Normal checked and proposes its rate", async () => {
    stub.getFeeEstimates.mockResolvedValue(TIED);
    await openCloseDialog();
    await choose(closeOptions, "Normal");
    expect(checkedLabels(closeOptions())).toEqual(["Normal"]);
    expect(closeSummaryLine()).toBe(`Fee rate proposed: Normal, ~${TIED.options!.normal.rate} sat/vB`);
    const body = await confirmClose();
    expect(body.fee_rate).toBe(TIED.options!.normal.rate);
  });

  it("open: Normal and Economy tie; choosing Normal keeps Normal checked and sends its rate", async () => {
    stub.getFeeEstimates.mockResolvedValue(TIED);
    await showOpenForm();
    await choose(openOptions, "Normal");
    expect(checkedLabels(openOptions())).toEqual(["Normal"]);
    await openOpenModal();
    expect(feeRateRow()).toBe(`Normal, ~${TIED.options!.normal.rate} sat/vB`);
  });

  it("close: Cancel resets the choice to Economy", async () => {
    await openCloseDialog();
    await choose(closeOptions, "Priority");
    await click(buttons(dialog()).find((b) => b.textContent?.trim() === "Cancel")!);
    await click(buttons(host!).find((b) => b.textContent?.trim() === "Close")!);
    expect(checkedLabels(closeOptions())).toEqual(["Economy"]);
  });
});

// ─── P15: the 200 ceiling ────────────────────────────────────────────────────

describe("P15 — above the 200 ceiling: the figure, blocked, with the reason", () => {
  const SPIKE = feeEstimatesStub({ economy: 120, normal: 180, priority: 250 });

  it("close: Priority at 250 shows its figure, disabled, with the reason", async () => {
    stub.getFeeEstimates.mockResolvedValue(SPIKE);
    await openCloseDialog();
    const prio = closeOptions().find((o) => labelOf(o) === "Priority")!;
    expect(prio.querySelector(".choice-desc")?.textContent).toBe("~250 sat/vB");
    expect(prio.querySelector("input")!.disabled).toBe(true);
    expect(prio.querySelector(".choice-reason")?.textContent).toBe(FEE_COPY.aboveCeiling(200));
  });

  it("open: every option above 200 → submit blocked with the reason", async () => {
    stub.getFeeEstimates.mockResolvedValue(feeEstimatesStub({ economy: 210, normal: 230, priority: 260 }));
    await showOpenForm();
    expect(openSubmit().disabled).toBe(true);
    expect(openPanel().textContent).toContain(FEE_COPY.aboveCeiling(200));
  });
});

// ─── D6 ruling and F5 copy ───────────────────────────────────────────────────

describe("the close dialog's messages", () => {
  // Ethan, 2026-11-18: the D6 mapping extends to the cooperative close.
  it("D6: LND refusing the proposed rate as too low shows the ruled sentence", async () => {
    stub.treasuryCloseChannel.mockRejectedValue(
      Object.assign(new Error("fee_rate_below_network_minimum"), { status: 400, code: "fee_rate_below_network_minimum" }),
    );
    await openCloseDialog();
    await confirmClose();
    await flush();
    expect(document.body.textContent).toContain(FEE_COPY.tooLowForNetwork);
  });

  it("any other close failure keeps its own message", async () => {
    stub.treasuryCloseChannel.mockRejectedValue(Object.assign(new Error("peer offline"), { status: 500, code: "internal" }));
    await openCloseDialog();
    await confirmClose();
    await flush();
    expect(document.body.textContent).toContain("peer offline");
    expect(document.body.textContent).not.toContain(FEE_COPY.tooLowForNetwork);
  });
});

describe("the open panel's messages", () => {
  it("D6: LND refusing the rate as too low shows the ruled sentence", async () => {
    stub.treasuryOpenChannel.mockRejectedValue(
      Object.assign(new Error("fee_rate_below_network_minimum"), { status: 400, code: "fee_rate_below_network_minimum" }),
    );
    await showOpenForm();
    await confirmOpen();
    await flush();
    expect(openPanel().textContent).toContain(FEE_COPY.tooLowForNetwork);
  });

  it("F5: the submitted copy states the peer's depth, \"2 on most member nodes\"", async () => {
    stub.treasuryOpenChannel.mockResolvedValue({ ok: true, funding_txid: "ab".repeat(32) });
    await showOpenForm();
    await confirmOpen();
    await flush();
    expect(openPanel().textContent).toContain("Channel is usable once the peer confirms it — 2 on most member nodes.");
    expect(openPanel().textContent).not.toContain("1–3 on-chain confirmations");
  });
});

// ─── The cost line never splits (3b) ──────────────────────────────────────

describe("Choice's cost line", () => {
  it("is white-space: nowrap, so \"~192 sats\" never breaks across two lines", () => {
    expect(declsFor(".choice-cost")["white-space"]).toBe("nowrap");
  });
});

// ─── "fix the five" (2026-11-16), rewritten for live figures ───────────────
// Economy's worded cost ("Fee set by your node") is retired: every option has
// a figure now (MFRUI-ASKS (1)). The display rules stand.

describe("FeeCost on the treasury's two fee pickers", () => {
  const FRESH = { usd: 60_000, source: "coinbase", fetched_at: 1_790_000_000_000, age_ms: 0, state: "fresh" };
  const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };
  const card = (opts: HTMLElement[], label: string) => opts.find((o) => labelOf(o) === label)!;
  /** A card's cost lines, "data-line:text", in order. */
  const lines = (opts: HTMLElement[], label: string) =>
    [...card(opts, label).querySelectorAll(".choice-cost [data-line]")].map((l) => `${l.getAttribute("data-line")}:${l.textContent}`);

  it("1 — numbers stay on one line; the close card's qualifier may wrap (the CSS)", () => {
    expect(declsFor(".choice-cost")["white-space"]).toBe("nowrap");
    expect(declsFor(".amount-figure")["white-space"]).toBe("nowrap");
    expect(declsFor(".amount-sub")["white-space"]).toBe("nowrap");
    expect(declsFor(".fee-cost-qualifier")["white-space"]).toBe("normal");
  });

  // MFRUI's capture ask: a worded cost wraps through .fee-cost-words — a
  // block, balanced (balance evens the lines of a block, not of an inline span).
  it("1 — .fee-cost-words is the balanced block a worded cost wraps through", () => {
    const d = declsFor(".fee-cost-words");
    expect(d.display).toBe("block");
    expect(d["white-space"]).toBe("normal");
    expect(d["text-wrap"]).toBe("balance");
  });

  for (const [why, rate] of [["a price", FRESH], ["no price", NONE]] as const) {
    it(`1 — the close dialog, ${why}: the worded cost wraps through .fee-cost-words; the figure keeps its nowrap span`, async () => {
      stub.getExchangeRate.mockResolvedValue(rate);
      await openCloseDialog();
      for (const [i, key] of KEYS.entries()) {
        const sats = STUB.options![key].cost_sats.close;
        const words = card(closeOptions(), LABELS[i]).querySelectorAll(".choice-cost .fee-cost-words");
        expect(words, LABELS[i]).toHaveLength(1);
        const figure = words[0].querySelector(":scope > .amount-figure")?.textContent;
        expect(figure).toBe(rate === FRESH ? `about ${formatUsd(sats, 60_000).text}` : `~${formatSats(sats)}`);
        expect(words[0].querySelector(":scope > .fee-cost-qualifier")?.textContent).toBe(` ${PROPOSED}`);
      }
    });
  }

  it(`1 — the open panel: every card's cost is a figure; no worded cost, no "set by your node"`, async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await showOpenForm();
    for (const label of LABELS) {
      expect(card(openOptions(), label).querySelector(".choice-cost .fee-cost-words"), label).toBeNull();
      expect(card(openOptions(), label).querySelector(".choice-cost .amount"), label).not.toBeNull();
    }
    expect(document.body.textContent).not.toContain("set by your node");
  });

  it(`1 — the close dialog: no "set by your node"`, async () => {
    await openCloseDialog();
    expect(document.body.textContent).not.toContain("set by your node");
  });

  it("4 — the close dialog: every option shows its live rate, Economy included", async () => {
    await openCloseDialog();
    for (const [i, key] of KEYS.entries()) {
      expect(card(closeOptions(), LABELS[i]).querySelector(".choice-desc")?.textContent).toBe(`~${STUB.options![key].rate} sat/vB`);
    }
  });

  it("5 — the close dialog: \"about $X proposed — the final fee is often higher\" over \"~N sats\" (D3; ruling 4)", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await openCloseDialog();
    for (const [i, key] of KEYS.entries()) {
      const sats = STUB.options![key].cost_sats.close;
      expect(lines(closeOptions(), LABELS[i])).toEqual([
        `usd:about ${formatUsd(sats, 60_000).text} ${PROPOSED}`,
        `sats:~${formatSats(sats)}`,
      ]);
    }
  });

  it("5 — the open panel: dollars over sats", async () => {
    stub.getExchangeRate.mockResolvedValue(FRESH);
    await showOpenForm();
    for (const [i, key] of KEYS.entries()) {
      const sats = STUB.options![key].cost_sats.open;
      expect(lines(openOptions(), LABELS[i])).toEqual([`usd:about ${formatUsd(sats, 60_000).text}`, `sats:~${formatSats(sats)}`]);
    }
  });

  for (const [why, setRate] of [
    ["no price (state none)", () => stub.getExchangeRate.mockResolvedValue(NONE)],
    ["a failed read", () => stub.getExchangeRate.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ] as const) {
    it(`5 — ${why}: sats only, on both pickers`, async () => {
      setRate();
      await openCloseDialog();
      for (const [i, key] of KEYS.entries()) {
        // FeeCost's sats fallback: the sats take the dollars' place, qualifier and all.
        expect(lines(closeOptions(), LABELS[i])).toEqual([`sats:~${formatSats(STUB.options![key].cost_sats.close)} ${PROPOSED}`]);
      }
      await click(buttons(dialog()).find((b) => b.textContent?.trim() === "Cancel")!);
      await click(buttons(openPanel()).find((b) => b.textContent?.trim() === "New Channel")!);
      for (const [i, key] of KEYS.entries()) {
        expect(lines(openOptions(), LABELS[i])).toEqual([`sats:~${formatSats(STUB.options![key].cost_sats.open)}`]);
      }
    });
  }
});

// ─── The close dialog's figure is frozen when it opens (Ethan, 2026-11-18) ──
// Like the modal's summary: the 5-min refresh does not move it. The 10-min
// rule at confirm still applies (H3 above: refresh, re-show, ask again).

/** Capture the estimate hooks' 5-min refresh ticks, to fire them by hand. */
function captureRefreshTicks() {
  const ticks: Array<() => void> = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === REFRESH_INTERVAL_MS) { ticks.push(fn); return 0 as unknown as ReturnType<typeof setInterval>; }
    return real(fn, ms, ...rest);
  }) as typeof setInterval);
  return async () => {
    expect(ticks.length, "a 5-min refresh is scheduled").toBeGreaterThan(0);
    for (const t of ticks) await act(async () => { t(); });
    await flush();
  };
}

describe("the close dialog's figure is frozen when it opens, like the modal's", () => {
  const T0 = Date.parse("2026-11-18T12:00:00.000Z");
  const LATER = feeEstimatesStub({ economy: 3, normal: 6, priority: 12 });

  it("the 5-min refresh runs but does not move the shown figure; the frozen rate is proposed", async () => {
    const tick = captureRefreshTicks();
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await openCloseDialog();
    const calls = stub.getFeeEstimates.mock.calls.length;
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 5 * 60_000);
    await tick();
    expect(stub.getFeeEstimates.mock.calls.length, "the refresh fetched").toBeGreaterThan(calls);
    expect(closeOptions().map((o) => o.textContent)).toEqual([0, 1, 2].map((i) => closeText(STUB, i)));
    expect(closeSummaryLine()).toBe(`Fee rate proposed: Economy, ~${STUB.options!.economy.rate} sat/vB`);
    now.mockReturnValue(T0 + 9 * 60_000);
    const body = await confirmClose();
    expect(body.fee_rate).toBe(STUB.options!.economy.rate);
  });

  it("a reopened dialog freezes a fresh answer, never the last opening's figure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await openCloseDialog();
    await click(buttons(dialog()).find((b) => b.textContent?.trim() === "Cancel")!);
    let answer!: (v: FeeEstimates) => void;
    stub.getFeeEstimates.mockImplementation(() => new Promise<FeeEstimates>((r) => { answer = r; }));
    now.mockReturnValue(T0 + 60_000);
    await click(buttons(host!).find((b) => b.textContent?.trim() === "Close")!);
    // The fresh answer has not arrived: no figure yet, and none from before.
    expect(dialog().textContent).not.toContain(`~${STUB.options!.economy.rate} sat/vB`);
    expect(closeButton().disabled).toBe(true);
    await act(async () => { answer(LATER); });
    await flush();
    expect(closeOptions().map((o) => o.textContent)).toEqual([0, 1, 2].map((i) => closeText(LATER, i)));
  });
});
