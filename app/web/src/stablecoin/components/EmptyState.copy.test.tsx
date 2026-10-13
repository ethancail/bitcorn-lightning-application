// The receive-address "Copy address" button must copy on a non-secure origin.
//
// Members reach their node over plain HTTP on a Tailscale or LAN IP, where
// navigator.clipboard is undefined (it exists only in secure contexts) or its
// writeText rejects. The handler used to call navigator.clipboard.writeText
// unguarded, so the button threw a TypeError there and copied nothing. The
// fix falls back to a hidden textarea + document.execCommand("copy"), modelled
// on AdminMembers.tsx's copy handler, and shows "✓ Copied" only when a copy
// actually succeeded.
//
// jsdom implements neither navigator.clipboard nor document.execCommand, so
// both are stubbed per test and removed afterwards. Harness:
// AdminMembers.heading.test.tsx's (createRoot + act, no Testing Library).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") },
}));

import EmptyState from "./EmptyState";

const ADDR = "0x" + "ab".repeat(20);

let host: HTMLDivElement;
let root: Root;
// What every textarea in the document held at the moment execCommand ran.
let textareasAtCall: string[][];

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function stubExecCommand(returns: boolean) {
  const fn = vi.fn((_cmd: string) => {
    textareasAtCall.push(
      Array.from(document.querySelectorAll("textarea")).map((t) => t.value),
    );
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function openReceiveAndCopy() {
  await act(async () => {
    root.render(React.createElement(EmptyState, { walletAddress: ADDR, onSend: () => {} }));
  });
  await act(async () => { buttonByText("Show my receive address").click(); });
  await flush();
  await act(async () => { buttonByText("Copy address").click(); });
  await flush();
}

beforeEach(() => {
  textareasAtCall = [];
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

describe("EmptyState copy address", () => {
  it("T1 non-secure (no navigator.clipboard): copies via a textarea holding exactly the address, and shows Copied", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(true);

    await openReceiveAndCopy();

    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[ADDR]]);
    expect(host.textContent).toContain("✓ Copied");
  });

  it("T2 writeText rejects: falls back to the textarea copy, and shows Copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    stubClipboard({ writeText });
    const exec = stubExecCommand(true);

    await openReceiveAndCopy();

    expect(writeText).toHaveBeenCalledWith(ADDR);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[ADDR]]);
    expect(host.textContent).toContain("✓ Copied");
  });

  it("T3 no clipboard and execCommand returns false: Copied does NOT appear, and the address is still shown", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(false);

    await openReceiveAndCopy();

    // The fallback really ran and really failed — not a crash before it.
    expect(exec).toHaveBeenCalledWith("copy");
    expect(host.textContent).not.toContain("Copied");
    // Anti-vacuity: the receive view is rendered, address included.
    expect(host.querySelector(".stablecoin-empty-address")?.textContent).toBe(ADDR);
    expect(buttonByText("Copy address")).toBeTruthy();
  });

  it("T4 secure (writeText resolves): shows Copied and never touches execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const exec = stubExecCommand(true);

    await openReceiveAndCopy();

    expect(writeText).toHaveBeenCalledWith(ADDR);
    expect(exec).not.toHaveBeenCalled();
    expect(host.textContent).toContain("✓ Copied");
  });
});
