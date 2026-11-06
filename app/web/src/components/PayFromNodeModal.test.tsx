// PayFromNodeModal, as rendered (pay-from-node G3 rulings, 2026-11-06).
//
// R1: the modal renders through a portal to document.body, so the fixed
// overlay is the viewport at every mount site. At G3 the Settings mount put it
// inside SubscriptionPanel's card: the overlay dimmed only the content column
// and the dialog's buttons were cut off. jsdom has no layout, so what is
// asserted is the property that removes that (the dialog is not inside the
// card, and is a child of <body>), as ActionConfirmModal.portal.test.tsx does.
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
