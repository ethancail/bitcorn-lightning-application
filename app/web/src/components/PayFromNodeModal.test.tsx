// PayFromNodeModal, as rendered (pay-from-node G3 rulings, 2026-11-06).
//
// R1: the modal renders through a portal to document.body, so the fixed
// overlay is the viewport at every mount site. At G3 the Settings mount put it
// inside SubscriptionPanel's card: the overlay dimmed only the content column
// and the dialog's buttons were cut off. jsdom has no layout, so what is
// asserted is the property that removes that (the dialog is not inside the
// card, and is a child of <body>), as ActionConfirmModal.portal.test.tsx does.
//
// R2: on a phone an amount never breaks inside itself and the address ends in
// an ellipsis (phone-m15 showed "(3,749 s / ats)" and "…lzsq8 / kct").
//
// Harness: react-dom/client createRoot inside act(), no Testing Library; the
// api client is stubbed (the SubscriptionPanel.p2.test.tsx idiom).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const stub = vi.hoisted(() => ({
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  payFromNode: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import PayFromNodeModal from "./PayFromNodeModal";
import { declsFor } from "../styleRules.testutil";
import { classifyConfirmError } from "./actionConfirm/confirmErrors";

const ADDR = "bc1q" + "d".repeat(38);
const PRICE = 42_000;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
  stub.getPayFromNodeQuote.mockResolvedValue({ amount_sats: PRICE, deposit_address: ADDR, estimated_fee_sats: 1_234 });
  stub.payFromNode.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

/** Mount the modal inside a page card, as SubscriptionPanel and the dashboard banner place it. */
async function mountInCard() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(
        "div",
        { className: "panel fade-in", "data-testid": "page-card" },
        React.createElement("span", { "data-testid": "in-card" }),
        React.createElement(PayFromNodeModal, {
          status: { price_sats: PRICE, deposit_address: ADDR },
          onClose: () => undefined,
        }),
      ),
    );
  });
  await flush();
  return {
    card: host.querySelector('[data-testid="page-card"]'),
    inCard: host.querySelector('[data-testid="in-card"]'),
    dialog: document.querySelector('[role="dialog"]'),
  };
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent === label);
}

describe("R1: the pay modal renders outside the page's card", () => {
  it("mounts under document.body, not inside the card it was rendered from", async () => {
    const { card, inCard, dialog } = await mountInCard();
    // Anti-vacuity: both ends exist, so "not contained" cannot pass on a null.
    expect(card).not.toBeNull();
    expect(dialog).not.toBeNull();
    // Control: an element rendered in the card without a portal IS contained,
    // so the containment check can see containment when it is there.
    expect(card!.contains(inCard)).toBe(true);

    expect(card!.contains(dialog)).toBe(false);
    expect(dialog!.parentElement).toBe(document.body);
    expect(dialog!.querySelector(".dialog-title")?.textContent).toBe("Where is your BTC?");
  });

  it("the portal goes when the modal unmounts", async () => {
    await mountInCard();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root!.unmount());
    root = null;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the chooser still drives the modal from inside the portal", async () => {
    await mountInCard();
    await act(async () => { buttonNamed("Pay from this node")!.click(); });
    await flush();
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Pay from this node");
  });
});

/** A refusal as apiFetch throws it: the code, and the parsed body. */
function refusal(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(String(body.error)), {
    status, code: body.error, detail: body.detail, body,
  });
}

const NONE = { usd: null, source: "coinbase", fetched_at: null, age_ms: null, state: "none" };
const STALE = { usd: 60_000, source: "coinbase", fetched_at: Date.now() - 601_000, age_ms: 601_000, state: "stale" };
const NONE_SENTENCE = "The bitcoin price isn't available right now, so amounts are shown in sats.";
const MARKER = { id: 4, created_at: Math.floor(Date.now() / 1000) - 600, amount_sats: 37_000, txid: "e".repeat(64) };

const card = () => document.querySelector(".sub-pay-modal")!;
const cardText = () => card().textContent ?? "";

async function toConfirm() {
  await act(async () => { buttonNamed("Pay from this node")!.click(); });
  await flush();
}

async function confirmRefusedWith(err: Error) {
  stub.payFromNode.mockRejectedValueOnce(err);
  await toConfirm();
  await act(async () => { buttonNamed("Confirm send")!.click(); });
  await flush();
}

const repeatRefusal = () => refusal(409, { error: "repeat_unacknowledged", marker: MARKER });
const priceRefusal = (acknowledged: number | null) =>
  refusal(409, { error: "price_above_acknowledged", price_sats: PRICE, acknowledged_price_sats: acknowledged });

describe("R7: the no-rate sentence on every amount step", () => {
  beforeEach(() => { stub.getExchangeRate.mockResolvedValue(NONE); });

  it("chooser", async () => {
    await mountInCard();
    expect(cardText()).toContain(NONE_SENTENCE);
  });

  it("confirm", async () => {
    await mountInCard();
    await toConfirm();
    expect(cardText()).toContain(NONE_SENTENCE);
  });

  it("repeat_ack", async () => {
    await mountInCard();
    await confirmRefusedWith(repeatRefusal());
    expect(document.querySelector(".dialog-title")?.textContent).toBe("You already sent a payment");
    expect(cardText()).toContain(NONE_SENTENCE);
  });

  it("price_ack", async () => {
    await mountInCard();
    await confirmRefusedWith(priceRefusal(30_000));
    expect(document.querySelector(".dialog-title")?.textContent).toBe("The subscription price went up");
    expect(cardText()).toContain(NONE_SENTENCE);
  });

  it("bip21", async () => {
    await mountInCard();
    await act(async () => { buttonNamed("I have BTC elsewhere")!.click(); });
    await flush();
    expect(document.querySelector(".dialog-title")?.textContent).toBe("I have BTC elsewhere");
    expect(cardText()).toContain(NONE_SENTENCE);
  });

  it("a fresh rate: no note on any of them (control: the note is conditional)", async () => {
    stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: Date.now(), age_ms: 0, state: "fresh" });
    await mountInCard();
    expect(cardText()).not.toContain(NONE_SENTENCE);
    expect(cardText()).toContain("$25.20");
  });
});

describe("R7: past amounts in sats only", () => {
  it("repeat_ack: the payment already sent is in sats, with no dollar figure", async () => {
    await mountInCard();
    await confirmRefusedWith(repeatRefusal());
    const body = document.querySelector(".sub-pay-modal .dialog-body")!.textContent!;
    expect(body).toContain("Your node sent 37,000 sats to your subscription address");
    expect(body).not.toContain("$");
  });

  it("repeat_ack with a stale rate: no \"Price as of\", since no dollar figure is shown", async () => {
    stub.getExchangeRate.mockResolvedValue(STALE);
    await mountInCard();
    await confirmRefusedWith(repeatRefusal());
    expect(cardText()).not.toContain("Price as of");
  });

  it("price_ack: the new price dollars first, the old one in sats", async () => {
    await mountInCard();
    await confirmRefusedWith(priceRefusal(30_000));
    const body = document.querySelector(".sub-pay-modal .dialog-body")!.textContent!;
    expect(body).toBe(
      "The price is now $25.20 (42,000 sats), up from 30,000 sats. Nothing is sent until you accept the new price.",
    );
  });

  it("price_ack with no previously agreed price: no \"up from\"", async () => {
    await mountInCard();
    await confirmRefusedWith(priceRefusal(null));
    const body = document.querySelector(".sub-pay-modal .dialog-body")!.textContent!;
    expect(body).toBe("The price is now $25.20 (42,000 sats). Nothing is sent until you accept the new price.");
  });

  it("price_ack with a stale rate: dated, since the new price is in dollars", async () => {
    stub.getExchangeRate.mockResolvedValue(STALE);
    await mountInCard();
    await confirmRefusedWith(priceRefusal(30_000));
    expect(cardText()).toContain("Price as of");
  });
});

describe("R6 and R10: repeat_ack and details-changed as ruled", () => {
  it("repeat_ack: the approved sentence, and \"Not now\" in place of \"Wait\"", async () => {
    await mountInCard();
    await confirmRefusedWith(repeatRefusal());
    const body = document.querySelector(".sub-pay-modal .dialog-body")!.textContent!;
    expect(body).toContain(
      "It hasn't been credited yet. Most payments are credited soon after their first confirmation.",
    );
    expect(body).not.toContain("within an hour");
    expect(buttonNamed("Not now")).toBeDefined();
    expect(buttonNamed("Wait")).toBeUndefined();
    expect(buttonNamed("Send another payment")).toBeDefined();
  });

  it("details-changed is an amber warning, not a red danger notice", async () => {
    await mountInCard();
    stub.getPayFromNodeQuote.mockResolvedValue({ amount_sats: 45_000, deposit_address: ADDR, estimated_fee_sats: 1_234 });
    await confirmRefusedWith(refusal(409, { error: "pay_target_changed" }));
    const notice = [...document.querySelectorAll(".sub-pay-modal .sub-alert")]
      .find((n) => n.textContent?.includes("The payment details changed."));
    expect(notice).toBeDefined();
    expect(notice!.classList.contains("sub-alert-amber")).toBe(true);
    expect(notice!.classList.contains("sub-alert-dim-red")).toBe(false);
    // The re-quoted amount is what is now shown.
    expect(document.querySelector(".sub-pay-preview dd")?.textContent).toBe("$27.00 (45,000 sats)");
  });
});

describe("R8: this modal's confirmation errors", () => {
  const errorText = () => document.querySelector(".sub-pay-modal .sub-alert-body")?.textContent;

  it("confirmation_required reads as this modal's sentence, with Try again", async () => {
    await mountInCard();
    await confirmRefusedWith(refusal(400, { error: "confirmation_required", detail: "no header" }));
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Payment failed");
    expect(errorText()).toBe("Not confirmed. Nothing was sent. Close this window and try again.");
    expect(buttonNamed("Try again")).toBeDefined();
  });

  it("confirmation_mismatch shows no Try again, only Close", async () => {
    await mountInCard();
    await confirmRefusedWith(refusal(409, { error: "confirmation_mismatch", detail: "does not match" }));
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Payment failed");
    expect(errorText()).toContain("This is a bug — nothing was sent");
    expect(buttonNamed("Close")).toBeDefined();
    expect(buttonNamed("Try again")).toBeUndefined();
  });

  it("control: another error on the same step does show Try again", async () => {
    // Without this, "no Try again" could pass because the query never finds
    // the button on the error step at all.
    await mountInCard();
    await confirmRefusedWith(refusal(502, { error: "send_failed", detail: "sendcoins failed" }));
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Payment failed");
    expect(buttonNamed("Try again")).toBeDefined();
  });

  it("status_incomplete (no numeric paid_through, ruled 2026-11-09) shows the ruled sentence", async () => {
    await mountInCard();
    await confirmRefusedWith(refusal(503, { error: "status_incomplete", detail: "treasury status has no numeric paid_through" }));
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Payment failed");
    expect(errorText()).toBe("Nothing was sent. Your node couldn't read your subscription status; try again later.");
  });

  it("the shared classifier's copy is unchanged (the override is this modal's only)", () => {
    expect(classifyConfirmError({ status: 400, code: "confirmation_required" })?.detail).toBe(
      "This action needs a confirmation and none was sent. Check that every field is filled in, then confirm again.",
    );
    expect(classifyConfirmError({ status: 409, code: "confirmation_mismatch" })?.retryable).toBe(false);
  });
});

describe("R2: amounts never break inside themselves; the address truncates", () => {
  it("the preview's values have no break-all, an amount is nowrap, the address ellipsises", () => {
    expect(declsFor(".sub-pay-preview dd")["word-break"]).toBeUndefined();
    expect(declsFor(".sub-pay-preview dd")["min-width"]).toBe("0");
    expect(declsFor(".sub-amount")).toMatchObject({ "white-space": "nowrap" });
    expect(declsFor(".sub-pay-preview dd.sub-pay-address")).toMatchObject({
      overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
    });
  });

  it("on confirm, the amount and the fee are each one .sub-amount unit, and the address carries .sub-pay-address", async () => {
    await mountInCard();
    await act(async () => { buttonNamed("Pay from this node")!.click(); });
    await flush();
    const dds = [...document.querySelectorAll(".sub-pay-preview dd")];
    expect(dds).toHaveLength(3);
    const [amount, address, fee] = dds;
    // 42,000 sats at $60,000 = $25.20; the fee 1,234 sats = $0.74.
    expect(amount.querySelector(".sub-amount")?.textContent).toBe("$25.20 (42,000 sats)");
    expect(fee.querySelector(".sub-amount")?.textContent).toBe("~$0.74 (1,234 sats)");
    expect(address.classList.contains("sub-pay-address")).toBe(true);
    expect(address.getAttribute("title")).toBe(ADDR);
  });
});
