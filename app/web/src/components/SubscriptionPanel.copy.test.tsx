// SubscriptionPanel's two copy buttons must copy on a non-secure origin
// (member-ui-fixes item 3).
//
// Members reach their node over plain HTTP on a Tailscale or LAN IP, where
// navigator.clipboard is undefined. Both handlers called
// navigator.clipboard?.writeText with no fallback, so on plain HTTP the
// buttons copied nothing — "Copy address" in the deposit block, and "Copy
// pubkey" in the state-unavailable panel. Both now go through the shared
// copyText helper, and "✓ Copied" (the deposit block's only feedback; the
// pubkey button has none) shows only when a copy actually succeeded.
//
// Modelled on stablecoin/components/EmptyState.copy.test.tsx: jsdom
// implements neither navigator.clipboard nor document.execCommand, so both
// are stubbed per test and removed afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") },
}));

const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  getAutoPayConfig: vi.fn(),
  getAutoPayHistory: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import SubscriptionPanel from "./SubscriptionPanel";

const PUBKEY = "02" + "c".repeat(64);
const ADDR = "bc1q" + "d".repeat(38);
const DAY = 86_400_000;

const CURRENT = {
  applicable: true,
  member_pubkey: PUBKEY,
  current_tier: "current",
  paid_through: Date.now() + 20 * DAY,
  price_sats: 50_000,
  period_days: 30,
  deposit_address: ADDR,
  last_payment_at: Date.now() - 10 * DAY,
  last_payment_txid: "f".repeat(64),
  grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
};
const MISSING = { applicable: false, reason: "missing" };

let host: HTMLDivElement;
let root: Root;
// What every textarea in the document held at the moment execCommand ran.
let textareasAtCall: string[][];

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function stubExecCommand(returns: boolean) {
  const fn = vi.fn((_cmd: string) => {
    textareasAtCall.push(Array.from(document.querySelectorAll("textarea")).map((t) => t.value));
    return returns;
  });
  Object.defineProperty(document, "execCommand", { value: fn, configurable: true, writable: true });
  return fn;
}

function buttonByText(text: string): HTMLButtonElement {
  const b = Array.from(host.querySelectorAll("button")).find((el) => el.textContent === text);
  if (!b) throw new Error(`no button "${text}"; buttons: ${Array.from(host.querySelectorAll("button")).map((el) => el.textContent).join(" | ")}`);
  return b as HTMLButtonElement;
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderAndCopy(status: unknown, button: string) {
  stub.getSubscriptionStatus.mockResolvedValue(status);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(SubscriptionPanel)));
  });
  await flush();
  await act(async () => { buttonByText(button).click(); });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  textareasAtCall = [];
  stub.getNode.mockResolvedValue({ pubkey: PUBKEY });
  stub.getAutoPayConfig.mockImplementation(never);
  stub.getAutoPayHistory.mockImplementation(never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  delete (navigator as any).clipboard;
  delete (document as any).execCommand;
});

describe("SubscriptionPanel deposit block: Copy address", () => {
  it("D1 non-secure (no navigator.clipboard): copies via a textarea holding exactly the address, and shows Copied", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(true);

    await renderAndCopy(CURRENT, "Copy address");

    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[ADDR]]);
    expect(host.textContent).toContain("✓ Copied");
  });

  it("D2 no clipboard and execCommand returns false: Copied does NOT appear, and the address is still shown", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(false);

    await renderAndCopy(CURRENT, "Copy address");

    // The fallback really ran and really failed — not a crash before it.
    expect(exec).toHaveBeenCalledWith("copy");
    expect(host.textContent).not.toContain("Copied");
    // Anti-vacuity: the deposit block is rendered, address and button included.
    expect(host.querySelector(".sub-deposit-address")?.textContent?.replace(/\s/g, "")).toBe(ADDR);
    expect(buttonByText("Copy address")).toBeTruthy();
  });

  it("D3 secure (writeText resolves): shows Copied and never touches execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const exec = stubExecCommand(true);

    await renderAndCopy(CURRENT, "Copy address");

    expect(writeText).toHaveBeenCalledWith(ADDR);
    expect(exec).not.toHaveBeenCalled();
    expect(host.textContent).toContain("✓ Copied");
  });
});

describe("SubscriptionPanel state-unavailable panel: Copy pubkey", () => {
  it("P1 non-secure (no navigator.clipboard): copies via a textarea holding exactly the pubkey", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(true);

    await renderAndCopy(MISSING, "Copy pubkey");

    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[PUBKEY]]);
  });

  it("P2 no clipboard and execCommand returns false: no Copied, and the pubkey is still shown", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(false);

    await renderAndCopy(MISSING, "Copy pubkey");

    expect(exec).toHaveBeenCalledWith("copy");
    expect(host.textContent).not.toContain("Copied");
    expect(host.querySelector(".sub-pubkey")?.textContent).toBe(PUBKEY);
  });
});
