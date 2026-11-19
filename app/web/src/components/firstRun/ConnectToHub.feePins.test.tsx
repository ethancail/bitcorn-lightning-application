// The member's fee-speed picker decides what the member pays to open a channel
// (orchestrator addendum 1, 2026-11-13). This file pins its options' labels,
// keys, default and the value each one sends.
//
// REWRITTEN DELIBERATELY for fee-estimates (spec §13 items 2 and 8; MFRUI-ASKS
// (2)), never deleted. Until 2026-11-18 it pinned develop 0536e70's FIXED
// options — Economy sending NO fee_rate, Normal 5, Priority 15, "~770 sats" —
// and "Fee set by your node" for Economy. Under O2 those pins go red, correctly:
// every option, Economy included, now sends the live integer rate it shows.
// The subjects are unchanged (label, key, default, value sent, cost line); the
// expectations are now DERIVED FROM THE STUBBED /api/fee-estimates answer (H1),
// never typed as literals. The "untouched form sends no fee_rate" pin is now
// "an untouched form sends Economy's shown rate" (§13 item 2).
//
// The rate is read off the openMemberChannel call — what is actually sent.
//
// Also here (§13): H2 sent = shown on every option, H3 the 10-min bound at
// confirm, H4 Economy sends a rate, H6 the unavailable state, the option key
// with tied rates (F3), the 200 ceiling (P15), the data's age (P18), the 5-min
// refresh, the D6 "too low" copy, and the confirm summary's rate equal to the
// hashed rate (CONFIRM-RULING).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { FeeEstimates } from "../../api/client";
import { feeEstimatesStub, UNAVAILABLE } from "../fees/feeEstimates.testutil";
import { FEE_COPY, timeText } from "../fees/feeEstimatesDescriptor";
import { formatSats, formatUsd } from "../amount/amountDescriptor";
import { confirmationFor, findUiConfirmedRoute } from "../../api/actionConfirmation";
import { declsFor } from "../../styleRules.testutil";

const stub = vi.hoisted(() => ({
  getTreasuryInfo: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  openMemberChannel: vi.fn(),
  getFeeEstimates: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import ConnectToHub from "./ConnectToHub";

/** The stub every pin derives from. Distinct rates, so each option is told apart. */
const STUB = feeEstimatesStub({ economy: 2, normal: 4, priority: 9 });
const KEYS = ["economy", "normal", "priority"] as const;
const LABELS = ["Economy", "Normal", "Priority"] as const;

/** An option card's whole text, from the stub: label, time, cost (no price → sats alone). */
const expectedText = (est: FeeEstimates, i: number) => {
  const o = est.options![KEYS[i]];
  return `${LABELS[i]}${timeText(o)}~${formatSats(o.cost_sats.open)}`;
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getSubscriptionStatus.mockImplementation(() => new Promise(() => {}));
  stub.openMemberChannel.mockImplementation(() => new Promise(() => {}));
  stub.getFeeEstimates.mockResolvedValue(STUB);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const c of [...document.body.children]) c.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(rate: unknown = undefined) {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/dashboard", element: React.createElement(ConnectToHub, { isPeered: true, rate: rate as any }) }),
        ),
      ),
    );
  });
  await flush();
}

/** The "How fast" column: the heading's parent section. */
function speedSection(): HTMLElement {
  const head = [...host.querySelectorAll(".form-label")].find((e) => e.textContent === "How fast");
  expect(head, "the How fast heading renders").toBeDefined();
  return head!.parentElement as HTMLElement;
}

/** The option cards: the element after the "How fast" heading, its labels. */
function feeOptions(): HTMLElement[] {
  const head = [...host.querySelectorAll(".form-label")].find((e) => e.textContent === "How fast");
  expect(head, "the How fast heading renders").toBeDefined();
  return [...head!.nextElementSibling!.querySelectorAll<HTMLElement>("label")];
}

const labelOf = (o: Element) => o.querySelector(".choice-label")?.textContent;
const checkedLabels = () => feeOptions().filter((o) => o.querySelector("input")?.checked).map(labelOf);

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

const btn = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

async function choose(label: string) {
  await click(feeOptions().find((o) => labelOf(o) === label)!);
}

/** The confirm modal's "Speed" row value. */
function speedRow(): string | undefined {
  const dts = [...document.body.querySelectorAll(".dialog-card dt")];
  return dts.find((d) => d.textContent === "Speed")?.nextElementSibling?.textContent ?? undefined;
}

async function openModal() {
  await click(btn("Connect to BitCorn →")!);
}

async function confirmModal() {
  await type(document.body.querySelector("#action-confirm-challenge") as HTMLInputElement, "1000000");
  await click(btn("Open channel")!);
}

/** Open the confirm modal, satisfy its 1,000,000-sat challenge, confirm; return the request body. */
async function submit(): Promise<Record<string, unknown>> {
  await openModal();
  await confirmModal();
  expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
  return stub.openMemberChannel.mock.calls[0][0];
}

describe("ConnectToHub's fee-speed picker: live labels, keys, default and values (H1, H2, H4)", () => {
  it("label (H1): three options, each card's text derived from the stub, in order", async () => {
    await render();
    expect(feeOptions().map((o) => o.textContent)).toEqual([0, 1, 2].map((i) => expectedText(STUB, i)));
  });

  it("the radios carry the ruled string keys", async () => {
    await render();
    expect(feeOptions().map((o) => o.querySelector("input")?.value)).toEqual([...KEYS]);
  });

  it("default (H4): Economy is the one checked option, and an untouched form sends Economy's shown rate", async () => {
    await render();
    expect(checkedLabels()).toEqual(["Economy"]);
    const body = await submit();
    expect(body.fee_rate).toBe(STUB.options!.economy.rate);
    expect(typeof body.fee_rate).toBe("number");
  });

  KEYS.forEach((key, i) => {
    it(`value (H2): choosing ${LABELS[i]} sends the rate behind its shown figure`, async () => {
      await render();
      const other = LABELS[(i + 1) % 3];
      await choose(other);
      await choose(LABELS[i]);
      expect(checkedLabels()).toEqual([LABELS[i]]);
      // The figure shown on the card is rate × 155 vB; what is sent is that rate.
      const card = feeOptions().find((o) => labelOf(o) === LABELS[i])!;
      expect(card.textContent).toContain(`~${formatSats(STUB.options![key].rate * 155)}`);
      const body = await submit();
      expect(body.fee_rate).toBe(STUB.options![key].rate);
    });
  });

  it("the footer's fee is the checked option's cost", async () => {
    await render();
    await choose("Priority");
    const summary = host.querySelector(".connect-summary")?.textContent;
    expect(summary).toBe(`1,000,000 sats · network fee about ${formatSats(STUB.options!.priority.cost_sats.open)}`);
  });

  it("Technical details shows the live rates (P19)", async () => {
    await render();
    expect(host.textContent).toContain("Economy ~2 sat/vB · Normal ~4 sat/vB · Priority ~9 sat/vB");
  });

  it("under the LND fallback the time is labelled estimate (O1)", async () => {
    stub.getFeeEstimates.mockResolvedValue(feeEstimatesStub({ economy: 2, normal: 4, priority: 9 }, { source: "lnd" }));
    await render();
    for (const o of feeOptions()) expect(o.querySelector(".choice-desc")?.textContent).toMatch(/ · estimate$/);
  });
});

describe("the confirm summary's rate equals the hashed rate (CONFIRM-RULING)", () => {
  KEYS.forEach((key, i) => {
    it(`${LABELS[i]}: the "Speed" row shows the rate the request carries and the confirmation hashes`, async () => {
      await render();
      await choose(LABELS[(i + 1) % 3]);
      await choose(LABELS[i]);
      await openModal();
      const row = speedRow();
      expect(row).toBe(`${LABELS[i]} (about ${STUB.options![key].rate} sat/vB)`);
      const rowRate = Number(/about (\d+) sat\/vB/.exec(row!)![1]);
      await confirmModal();
      const body = stub.openMemberChannel.mock.calls[0][0];
      // The hash apiFetch derives from exactly this body.
      const d = confirmationFor(findUiConfirmedRoute("POST", "/api/member/open-channel")!, "/api/member/open-channel", JSON.stringify(body));
      expect(d.ok).toBe(true);
      expect(body.fee_rate).toBe(rowRate);
      if (d.ok) expect(d.canonical).toContain(`fee_rate=${rowRate}`);
    });
  });
});

describe("H3 — the 10-min bound at confirm (O6, P18)", () => {
  const T0 = Date.parse("2026-11-18T12:00:00.000Z");
  const LATER = feeEstimatesStub({ economy: 3, normal: 6, priority: 12 });

  it("under the bound: the shown rate is sent, even if a newer estimate exists", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await render();
    await openModal();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 9 * 60_000);
    await confirmModal();
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(stub.openMemberChannel.mock.calls[0][0].fee_rate).toBe(STUB.options!.economy.rate);
  });

  it("over the bound: refreshed, re-shown, and NOTHING is sent until the new figure is confirmed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await render();
    await openModal();
    expect(speedRow()).toBe(`Economy (about ${STUB.options!.economy.rate} sat/vB)`);

    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 11 * 60_000);
    await confirmModal();
    // Nothing sent; the modal is back at the challenge with the new figure.
    expect(stub.openMemberChannel).not.toHaveBeenCalled();
    expect(speedRow()).toBe(`Economy (about ${LATER.options!.economy.rate} sat/vB)`);
    expect(noticeHeading()).toBe("Fee updated");
    expect((document.body.querySelector("#action-confirm-challenge") as HTMLInputElement).value).toBe("");

    // Confirming again sends the new, shown rate.
    await confirmModal();
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(stub.openMemberChannel.mock.calls[0][0].fee_rate).toBe(LATER.options!.economy.rate);
  });
});

// The member's reshow wording (Ethan, "recs" via member-first-run-ui,
// 2026-11-18): heading "Fee updated", the new fee in FeeCost's format, and the
// type-to-confirm box cleared and required again. The treasury's modals keep
// their own line (App.feePins).
const noticeHeading = () => document.body.querySelector(".action-confirm-notice-heading")?.textContent;
const noticeBody = () => document.body.querySelector(".action-confirm-notice-body")?.textContent;
const challengeBox = () => document.body.querySelector("#action-confirm-challenge") as HTMLInputElement;

describe("the member's 10-min reshow: \"Fee updated\", the new fee, the box cleared and required again", () => {
  const T0 = Date.parse("2026-11-18T12:00:00.000Z");
  const LATER = feeEstimatesStub({ economy: 3, normal: 6, priority: 12 });
  const FRESH = { usd: 60_000, source: "coinbase", fetched_at: 1_790_000_000_000, age_ms: 0, state: "fresh" };
  const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };

  async function reshow(rate: unknown) {
    const now = vi.spyOn(Date, "now").mockReturnValue(T0);
    await render(rate);
    await openModal();
    stub.getFeeEstimates.mockResolvedValue(LATER);
    now.mockReturnValue(T0 + 11 * 60_000);
    await confirmModal();
    expect(stub.openMemberChannel).not.toHaveBeenCalled();
  }

  it("with a price: \"The new fee is about $X (N sats).\"", async () => {
    await reshow(FRESH);
    const sats = LATER.options!.economy.cost_sats.open;
    expect(noticeHeading()).toBe("Fee updated");
    expect(noticeBody()).toBe(
      `Network fees changed while this was open. The new fee is about ${formatUsd(sats, 60_000).text} (${formatSats(sats)}). Type the amount again to confirm.`,
    );
    expect(document.body.textContent).not.toContain(FEE_COPY.refreshed);
  });

  for (const [why, rate] of [["no price (state none)", NONE], ["the price still loading", undefined]] as const) {
    it(`${why}: sats alone, "The new fee is about N sats."`, async () => {
      await reshow(rate);
      const sats = LATER.options!.economy.cost_sats.open;
      expect(noticeHeading()).toBe("Fee updated");
      expect(noticeBody()).toBe(
        `Network fees changed while this was open. The new fee is about ${formatSats(sats)}. Type the amount again to confirm.`,
      );
      expect(noticeBody()).not.toContain("$");
    });
  }

  it("the type-to-confirm box is cleared, and confirming is blocked until the amount is typed again", async () => {
    await reshow(FRESH);
    expect(challengeBox().value).toBe("");
    expect(btn("Open channel")!.disabled).toBe(true);
    await click(btn("Open channel")!);
    expect(stub.openMemberChannel).not.toHaveBeenCalled();
    await type(challengeBox(), "999999");
    expect(btn("Open channel")!.disabled).toBe(true);
    await type(challengeBox(), "1000000");
    expect(btn("Open channel")!.disabled).toBe(false);
    await click(btn("Open channel")!);
    expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
    expect(stub.openMemberChannel.mock.calls[0][0].fee_rate).toBe(LATER.options!.economy.rate);
  });
});

// REWRITTEN DELIBERATELY (Ethan's "recs" via member-first-run-ui's review,
// relayed 2026-11-18, ruling 1), never deleted. Until then this pinned a red
// "Fee estimate unavailable" (.connect-error) under "How fast" and the footer
// "1,000,000 sats · Fee estimate unavailable". Now: one plain line under "How
// fast", the normal text colour, and the footer the size alone. The subjects
// stand: no number, no radios, nothing sent.
const MEMBER_UNAVAILABLE =
  "Fee estimates aren't available right now, so you can't connect yet. Try again in a few minutes.";

describe("H6 — the unavailable state shows no number and sends nothing (O7)", () => {
  for (const [why, setUp] of [
    ["the API answers unavailable", () => stub.getFeeEstimates.mockResolvedValue(UNAVAILABLE)],
    ["the read fails", () => stub.getFeeEstimates.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }))],
  ] as const) {
    it(`${why}: one plain line, no figure, the footer the size alone, submit blocked`, async () => {
      setUp();
      await render();
      const section = speedSection();
      const lines = section.querySelectorAll(".connect-fee-unavailable");
      expect(lines, "exactly one unavailable line under How fast").toHaveLength(1);
      expect(lines[0].textContent).toBe(MEMBER_UNAVAILABLE);
      expect(lines[0].classList.contains("connect-error"), "not the red error class").toBe(false);
      expect(section.querySelectorAll(".connect-error")).toHaveLength(0);
      expect(section.textContent).not.toContain(FEE_COPY.unavailable);
      expect(section.textContent).not.toMatch(/sat|~|\$/);
      expect(section.querySelectorAll("input[type=radio]")).toHaveLength(0);
      expect(host.querySelector(".connect-summary")?.textContent).toBe("1,000,000 sats");
      expect(host.querySelector(".connect-foot-act")?.textContent).not.toMatch(/unavailable|aren't available/);
      expect(btn("Connect to BitCorn →")!.disabled).toBe(true);
      await click(btn("Connect to BitCorn →")!);
      expect(document.body.querySelector("#action-confirm-challenge")).toBeNull();
      expect(stub.openMemberChannel).not.toHaveBeenCalled();
    });
  }

  it("the line is the normal text colour, not red (the CSS)", () => {
    const d = declsFor(".connect-fee-unavailable");
    expect(d.color).toBe("var(--text)");
    expect(d.color).not.toBe(declsFor(".connect-error").color);
  });
});

describe("F3 — the option key: tied rates show honestly, the chosen option stays checked", () => {
  it("Normal and Economy tie: choosing Normal keeps Normal checked with its own cost, and sends its rate", async () => {
    const TIED = feeEstimatesStub({ economy: 1, normal: 1, priority: 2 });
    stub.getFeeEstimates.mockResolvedValue(TIED);
    await render();
    await choose("Normal");
    expect(checkedLabels()).toEqual(["Normal"]);
    for (const [i, key] of KEYS.entries()) {
      expect(feeOptions()[i].textContent).toContain(`~${formatSats(TIED.options![key].cost_sats.open)}`);
    }
    await openModal();
    expect(speedRow()).toBe(`Normal (about ${TIED.options!.normal.rate} sat/vB)`);
    await confirmModal();
    expect(stub.openMemberChannel.mock.calls[0][0].fee_rate).toBe(TIED.options!.normal.rate);
  });
});

describe("P15 — an option above the 200 ceiling shows its figure, blocked, with the reason", () => {
  it("Priority at 250: its figure shows, it is disabled with the reason; Economy still sends", async () => {
    const SPIKE = feeEstimatesStub({ economy: 120, normal: 180, priority: 250 });
    stub.getFeeEstimates.mockResolvedValue(SPIKE);
    await render();
    const prio = feeOptions().find((o) => labelOf(o) === "Priority")!;
    expect(prio.textContent).toContain(`~${formatSats(SPIKE.options!.priority.cost_sats.open)}`);
    expect(prio.querySelector("input")!.disabled).toBe(true);
    expect(prio.querySelector(".choice-reason")?.textContent).toBe(FEE_COPY.aboveCeiling(200));
    const body = await submit();
    expect(body.fee_rate).toBe(SPIKE.options!.economy.rate);
  });

  it("every option above 200: submit is blocked with the reason", async () => {
    stub.getFeeEstimates.mockResolvedValue(feeEstimatesStub({ economy: 210, normal: 230, priority: 260 }));
    await render();
    expect(btn("Connect to BitCorn →")!.disabled).toBe(true);
    expect(host.textContent).toContain(FEE_COPY.aboveCeiling(200));
  });
});

describe("P18 — the data's age shows from 10 min old", () => {
  it("under 10 min: no age line", async () => {
    stub.getFeeEstimates.mockResolvedValue(feeEstimatesStub({ economy: 2, normal: 4, priority: 9 }, { dataAgeSeconds: 9 * 60 }));
    await render();
    expect(host.querySelector(".fee-data-age")).toBeNull();
  });
  it("15 min old: \"Rates from 15 min ago\"", async () => {
    stub.getFeeEstimates.mockResolvedValue(feeEstimatesStub({ economy: 2, normal: 4, priority: 9 }, { dataAgeSeconds: 15 * 60 }));
    await render();
    expect(host.querySelector(".fee-data-age")?.textContent).toBe(FEE_COPY.dataAge(15));
  });
});

describe("refresh while the card is open (P2, P18)", () => {
  it("re-reads the estimate every 5 min", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await render();
    expect(stub.getFeeEstimates).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
    await flush();
    expect(stub.getFeeEstimates).toHaveBeenCalledTimes(2);
  });
});

describe("D6 ruling — LND refusing the rate as too low", () => {
  it("shows \"This rate is too low for the network right now — choose a faster option.\"", async () => {
    stub.openMemberChannel.mockRejectedValue(
      Object.assign(new Error("fee_rate_below_network_minimum"), { status: 400, code: "fee_rate_below_network_minimum" }),
    );
    await render();
    await submit();
    await flush();
    expect(host.querySelector(".connect-error")?.textContent).toBe(FEE_COPY.tooLowForNetwork);
  });
});
