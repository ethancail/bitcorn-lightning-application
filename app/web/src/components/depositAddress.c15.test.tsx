// C15 (treasury-price-trust; finding 8.1, ruled into this arc by Ethan,
// 2026-11-10): the subscription deposit address — and anything derived from
// it: its QR, its BIP-21 URI, its copy button, its tooltip — renders ONLY for a
// status this node verified whose address matches the pin. Otherwise the
// surface shows the S-state and no address.
//
// Each case asserts all three in ONE test: an unverified status renders none,
// a changed address renders none, and the same surface with a verified,
// matching status DOES render it (the anti-vacuity half: a surface that never
// rendered an address would otherwise pass).
//
// "Renders none" is checked on the whole document (the pay modal portals to
// body): the address string anywhere in the markup, any bitcoin: URI, and the
// QR encoder never asked to encode it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const qr = vi.hoisted(() => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") }));
vi.mock("qrcode", () => ({ default: qr }));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoPayHistory: vi.fn(),
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  payFromNode: vi.fn(),
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";
import PayFromNodeModal from "./PayFromNodeModal";
import RoutingDeniedNotice from "./RoutingDeniedNotice";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1qpinnedsubscriptionaddr000000000000zz";
const NEW_ADDR = "bc1qattackerstatedaddress0000000000000yy";
const PRICE = 42_000;

const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };
const UNSIGNED = { treasury_signature: "unsigned", treasury_signature_reason: null, treasury_pay_refusal: null };
// The treasury states NEW_ADDR; this node pinned ADDR (the proxy's label).
const CHANGED = {
  treasury_signature: "verified",
  treasury_signature_reason: null,
  treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: NEW_ADDR },
};

const status = (address: string, labels: Record<string, unknown>) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: "worker_lapsed",
  paid_through: NOW - 10 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: address,
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: NOW - 3 * DAY, routing_until: NOW + 20 * DAY, close_at: NOW + 50 * DAY },
  ...labels,
});

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue({
    enabled: false, enabled_at: null, last_acknowledged_price: null, last_acknowledged_price_at: null,
    current_price: PRICE, price_change_pending: false, status_verification: "verified",
    status_verification_reason: null, price_refusal: null, active_alerts: [],
    badge: { active_count: 0, highest_severity: null },
  });
  stub.getAutoPayHistory.mockResolvedValue([]);
  stub.getExchangeRate.mockResolvedValue({ usd: 60_000, source: "coinbase", fetched_at: NOW, age_ms: 0, state: "fresh" });
  stub.getPayFromNodeQuote.mockResolvedValue({ amount_sats: PRICE, deposit_address: ADDR, estimated_fee_sats: 1_234 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  nowSpy.mockRestore();
});

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
async function show(el: React.ReactElement) {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  qr.toDataURL.mockClear();
  await act(async () => { root.render(React.createElement(MemoryRouter, null, el)); });
  await flush();
}
const click = async (label: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === label);
  if (b) await act(async () => { b.click(); });
  await flush();
  return !!b;
};

/** Every form the address could take, anywhere in the document. */
function rendered(address: string) {
  const html = document.body.innerHTML;
  const lower = address.toLowerCase();
  // The panel shows the address in spaced chunks, so the text is compared with
  // whitespace removed as well as in the raw markup (attributes, tooltips).
  const flat = (document.body.textContent ?? "").replace(/\s+/g, "").toLowerCase();
  return {
    text: html.toLowerCase().includes(lower) || flat.includes(lower),
    uri: /bitcoin:/i.test(html),
    qr: qr.toDataURL.mock.calls.some((c) => String(c[0]).toLowerCase().includes(lower)),
    copy: [...document.querySelectorAll("button")].some((b) => b.textContent === "Copy address"),
  };
}
const NONE = { text: false, uri: false, qr: false, copy: false };

describe("C15 — the deposit address renders only when verified and pinned", () => {
  it("the Settings panel's deposit block: no address, QR, URI or copy unless verified and matching", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(status(ADDR, UNSIGNED));
    await show(React.createElement(SubscriptionPanel));
    expect(rendered(ADDR), "C15: an unverified status rendered the deposit address").toEqual(NONE);
    expect(host.querySelector("[data-trust-state='S1_unsigned']")).not.toBeNull();

    stub.getSubscriptionStatus.mockResolvedValue(status(NEW_ADDR, CHANGED));
    await show(React.createElement(SubscriptionPanel));
    expect(rendered(NEW_ADDR), "C15: a changed address was rendered").toEqual(NONE);

    // Anti-vacuity: verified and matching — the address, its QR, its URI and copy all render.
    stub.getSubscriptionStatus.mockResolvedValue(status(ADDR, VERIFIED));
    await show(React.createElement(SubscriptionPanel));
    expect(rendered(ADDR)).toEqual({ text: true, uri: false, qr: true, copy: true });
    expect(qr.toDataURL.mock.calls.some((c) => String(c[0]).startsWith("BITCOIN:"))).toBe(true);
  });

  it("the pay modal (from the dashboard banner): no address or BIP-21 URI unless verified and matching", async () => {
    const modal = (s: ReturnType<typeof status>) =>
      React.createElement(PayFromNodeModal, { status: s as any, onClose: () => undefined });

    await show(modal(status(ADDR, UNSIGNED)));
    await click("I have BTC elsewhere");
    await click("Pay from this node");
    expect(rendered(ADDR), "C15: the modal rendered an unverified address").toEqual(NONE);

    await show(modal(status(NEW_ADDR, CHANGED)));
    await click("I have BTC elsewhere");
    expect(rendered(NEW_ADDR), "C15: the modal rendered a changed address").toEqual(NONE);

    // Anti-vacuity: verified and matching, the BIP-21 handoff carries the address.
    await show(modal(status(ADDR, VERIFIED)));
    expect(await click("I have BTC elsewhere")).toBe(true);
    const a = document.querySelector('a[href^="bitcoin:"]') as HTMLAnchorElement | null;
    expect(a?.getAttribute("href")).toContain(ADDR.toLowerCase());
  });

  it("the routing-denied notice: its 402 address renders only when the status is verified and matching", async () => {
    const payload = { tier: "routing_lapsed", paid_through: NOW - 10 * DAY, deposit_address: ADDR, price_sats: PRICE };
    const notice = () => React.createElement(RoutingDeniedNotice, { payload, blockedAction: "send" });

    stub.getSubscriptionStatus.mockResolvedValue(status(ADDR, UNSIGNED));
    await show(notice());
    await click("Pay now");
    expect(rendered(ADDR), "C15: the notice rendered an address from an unverified status").toEqual(NONE);

    stub.getSubscriptionStatus.mockResolvedValue(status(NEW_ADDR, CHANGED));
    await show(notice());
    expect(rendered(ADDR).text || rendered(NEW_ADDR).text, "C15: the notice rendered an address while it changed").toBe(false);

    // Anti-vacuity: verified and matching, the notice shows the address and offers the pay modal.
    stub.getSubscriptionStatus.mockResolvedValue(status(ADDR, VERIFIED));
    await show(notice());
    expect(rendered(ADDR).text).toBe(true);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Pay now")).toBe(true);
  });
});
