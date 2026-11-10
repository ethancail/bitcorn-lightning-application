// treasury-price-trust on screen (bitcorn-research specs/2026-11-10-treasury-
// price-trust-spec.md §4 R3/R8, §8): the Settings panel's S1–S6 notice and
// disabled pay button, the pay modal's quote refusal with no confirm, and the
// auto-pay opt-in. The API is stubbed at api/client; nothing here verifies —
// the web only reads the labels this node's API sets.
//
// Each negative case carries its anti-vacuity half in the same test: the same
// fixture, verified and payable, enables the action.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") },
}));

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoPayHistory: vi.fn(),
  getExchangeRate: vi.fn(),
  getPayFromNodeQuote: vi.fn(),
  payFromNode: vi.fn(),
  setAutoPay: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";
import PayFromNodeModal from "./PayFromNodeModal";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const ADDR = "bc1q" + "d".repeat(38);
const PRICE = 42_000;

const lapsed = (labels: Record<string, unknown>) => ({
  applicable: true,
  member_pubkey: "02" + "c".repeat(64),
  current_tier: "worker_lapsed",
  paid_through: NOW - 10 * DAY,
  price_sats: PRICE,
  period_days: 30,
  deposit_address: ADDR,
  last_payment_at: null,
  last_payment_txid: null,
  grace: { fresh_until: 0, worker_until: NOW - 3 * DAY, routing_until: NOW + 20 * DAY, close_at: NOW + 50 * DAY },
  ...labels,
});
const VERIFIED = { treasury_signature: "verified", treasury_signature_reason: null, treasury_pay_refusal: null };

const autoPay = (o: Record<string, unknown> = {}) => ({
  enabled: false,
  enabled_at: null,
  last_acknowledged_price: null,
  last_acknowledged_price_at: null,
  current_price: PRICE,
  price_change_pending: false,
  status_verification: "verified",
  status_verification_reason: null,
  price_refusal: null,
  active_alerts: [],
  badge: { active_count: 0, highest_severity: null },
  ...o,
});

let host: HTMLDivElement;
let root: Root;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  stub.getNode.mockResolvedValue({ pubkey: "02" + "c".repeat(64) });
  stub.getAutoPayConfig.mockResolvedValue(autoPay());
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
async function remount(el: React.ReactElement) {
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await act(async () => { root.render(el); });
  await flush();
}
const panel = () => React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel));
const payButton = () =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("I have BTC")) as HTMLButtonElement | undefined;
const notice = () => host.querySelector("[data-trust-state]");

describe("the Settings panel (spec §8)", () => {
  it.each([
    ["S1 unsigned", { treasury_signature: "unsigned" }, "S1_unsigned", "Payments are paused."],
    ["S2 invalid", { treasury_signature: "invalid" }, "S2_invalid", "Payments are blocked."],
    ["S3 key_unset", { treasury_signature: "unverifiable", treasury_signature_reason: "key_unset" }, "S3_unverifiable", "missing Bitcorn's treasury key"],
    ["S4 above cap", { ...VERIFIED, treasury_pay_refusal: { code: "price_above_cap", detail: "", price_sats: 90_000 } }, "S4_price_above_cap", "$54.00 (90,000 sats)"],
    ["S5 not integer", { ...VERIFIED, treasury_pay_refusal: { code: "price_not_integer", detail: "", price_sats: 1.5 } }, "S5_price_not_integer", "won't pay"],
    ["S6 address changed", { ...VERIFIED, treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: ADDR, stated_address: "bc1qnew" + "e".repeat(30) } }, "S6_deposit_address_changed", "has changed"],
    ["no label at all", {}, "S1_unsigned", "Payments are paused."],
  ])("%s → the notice shows and the pay button is disabled", async (_l, labels, state, words) => {
    stub.getSubscriptionStatus.mockResolvedValue(lapsed(labels));
    await remount(panel());
    expect(payButton(), "the pay button is missing (setup)").toBeDefined();
    expect(payButton()!.disabled, "a payment was offered on an unverified or refused status").toBe(true);
    expect(notice()?.getAttribute("data-trust-state")).toBe(state);
    expect(notice()?.textContent).toContain(words);

    // Anti-vacuity: the same status, verified and payable — no notice, button live.
    stub.getSubscriptionStatus.mockResolvedValue(lapsed(VERIFIED));
    await remount(panel());
    expect(notice()).toBeNull();
    expect(payButton()!.disabled).toBe(false);
  });
});

describe("the pay modal's quote refusal (spec §4 R8)", () => {
  const modal = () =>
    // Verified at open; the QUOTE refuses (the case under test).
    React.createElement(PayFromNodeModal, { status: { price_sats: PRICE, deposit_address: ADDR, treasury_signature: "verified" }, onClose: () => undefined });
  const named = (label: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const refusal = (code: string, body: Record<string, unknown>) =>
    Object.assign(new Error(code), { status: 503, code, body: { error: code, ...body } });

  it("a refused quote shows its state and offers no confirm; nothing is sent", async () => {
    stub.getPayFromNodeQuote.mockRejectedValue(refusal("status_unverified", { reason: "unsigned" }));
    await remount(modal());
    await act(async () => { named("Pay from this node")!.click(); });
    await flush();
    const alert = document.querySelector('[role="dialog"] [data-trust-state]');
    expect(alert?.getAttribute("data-trust-state")).toBe("S1_unsigned");
    expect(named("Confirm send")!.disabled, "a confirm was offered on a refused quote").toBe(true);
    await act(async () => { named("Confirm send")!.click(); });
    expect(stub.payFromNode).not.toHaveBeenCalled();

    // Anti-vacuity: a quote that comes back leaves Confirm live, and it sends.
    stub.getPayFromNodeQuote.mockResolvedValue({ amount_sats: PRICE, deposit_address: ADDR, estimated_fee_sats: 1_234 });
    stub.payFromNode.mockResolvedValue({ txid: "ab".repeat(32) });
    await remount(modal());
    await act(async () => { named("Pay from this node")!.click(); });
    await flush();
    expect(document.querySelector('[role="dialog"] [data-trust-state]')).toBeNull();
    expect(named("Confirm send")!.disabled).toBe(false);
    await act(async () => { named("Confirm send")!.click(); });
    await flush();
    expect(stub.payFromNode).toHaveBeenCalledTimes(1);
  });

  it("an address change carries both addresses into S6", async () => {
    stub.getPayFromNodeQuote.mockRejectedValue(
      refusal("deposit_address_changed", { pinned_address: ADDR, stated_address: "bc1qnewaddress00000000000000ffff" }),
    );
    await remount(modal());
    await act(async () => { named("Pay from this node")!.click(); });
    await flush();
    const text = document.querySelector('[role="dialog"] [data-trust-state]')?.textContent ?? "";
    expect(text).toContain("bc1qdddd…dddddd");
    expect(text).toContain("bc1qnewa…00ffff");
  });
});

describe("the auto-pay opt-in (spec §4 R3, R10)", () => {
  const toggle = () => host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

  it("an unverified status disables opting IN and says why; opting OUT stays possible", async () => {
    stub.getSubscriptionStatus.mockResolvedValue(lapsed(VERIFIED));
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ status_verification: "unsigned", current_price: null }));
    await remount(panel());
    expect(toggle()!.disabled, "auto-pay could be turned on from an unverified status").toBe(true);
    expect(host.textContent).toContain("Payments are paused. Your node can't yet confirm");

    // Already on: turning it off is never blocked.
    stub.getAutoPayConfig.mockResolvedValue(autoPay({ enabled: true, status_verification: "unsigned", current_price: null }));
    await remount(panel());
    expect(toggle()!.disabled).toBe(false);

    // Anti-vacuity: verified and payable, opting in is offered.
    stub.getAutoPayConfig.mockResolvedValue(autoPay());
    await remount(panel());
    expect(toggle()!.disabled).toBe(false);
  });
});
