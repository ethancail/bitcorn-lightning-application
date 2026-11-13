// The member's fee-speed picker decides what the member pays to open a channel
// (orchestrator addendum 1, 2026-11-13). Converting it to Choice must change NO
// option's value, default or label, so this file pins all three, with the
// values develop (0536e70) shipped:
//   - label: each option's whole text, in order (label, time, cost);
//   - default: Economy is the checked option, and an untouched form sends no fee_rate;
//   - value: choosing each option sends exactly its rate.
// The rate is read off the openMemberChannel call — what is actually sent —
// not off the descriptor, so a changed rate in the descriptor turns this red.
//
// Harness: ConnectToHub.activateMembership.test.tsx's, plus the confirm-modal
// steps from MemberDashboard.connectToHub.states.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getTreasuryInfo: vi.fn(),
  getSubscriptionStatus: vi.fn(),
  openMemberChannel: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import ConnectToHub from "./ConnectToHub";

/** develop 0536e70's options, in order. */
const PINNED = [
  { label: "Economy", text: "Economy1–3 hours~155 sats", key: "economy", rate: undefined },
  { label: "Normal", text: "Normal~30 min~770 sats", key: "normal", rate: 5 },
  { label: "Priority", text: "Priority~10 min~2,300 sats", key: "priority", rate: 15 },
] as const;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getTreasuryInfo.mockResolvedValue(null);
  stub.getSubscriptionStatus.mockImplementation(() => new Promise(() => {}));
  stub.openMemberChannel.mockImplementation(() => new Promise(() => {}));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const c of [...document.body.children]) c.remove();
});

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render() {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard"] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/dashboard", element: React.createElement(ConnectToHub, { isPeered: true }) }),
        ),
      ),
    );
  });
  await flush();
}

/** The option cards: the element after the "Confirmation Speed" heading, its labels. */
function feeOptions(): HTMLElement[] {
  const head = [...host.querySelectorAll(".form-label")].find((e) => e.textContent === "Confirmation Speed");
  expect(head, "the Confirmation Speed heading renders").toBeDefined();
  return [...head!.nextElementSibling!.querySelectorAll<HTMLElement>("label")];
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

const btn = (text: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

/** Open the confirm modal, satisfy its 1,000,000-sat challenge, confirm; return the request body. */
async function submit(): Promise<Record<string, unknown>> {
  await click(btn("Open Channel →")!);
  await type(document.body.querySelector("#action-confirm-challenge") as HTMLInputElement, "1000000");
  await click(btn("Open channel")!);
  expect(stub.openMemberChannel).toHaveBeenCalledTimes(1);
  return stub.openMemberChannel.mock.calls[0][0];
}

describe("ConnectToHub's fee-speed picker: values, default and labels unchanged", () => {
  it("label: three options, each with develop's exact text, in order", async () => {
    await render();
    expect(feeOptions().map((o) => o.textContent)).toEqual(PINNED.map((p) => p.text));
  });

  it("the radios carry the ruled string keys", async () => {
    await render();
    expect(feeOptions().map((o) => o.querySelector("input")?.value)).toEqual(PINNED.map((p) => p.key));
  });

  it("default: Economy is the one checked option, and an untouched form sends no fee_rate", async () => {
    await render();
    const checked = feeOptions().filter((o) => o.querySelector("input")?.checked);
    expect(checked.map((o) => o.querySelector(".choice-label")?.textContent)).toEqual(["Economy"]);
    const body = await submit();
    expect(body.fee_rate).toBeUndefined();
  });

  for (const p of PINNED) {
    it(`value: choosing ${p.label} sends fee_rate ${String(p.rate)}`, async () => {
      await render();
      // Move off the target first, so choosing it is a real change even for the default.
      const other = PINNED.find((q) => q.label !== p.label)!;
      await click(feeOptions().find((o) => o.querySelector(".choice-label")?.textContent === other.label)!);
      await click(feeOptions().find((o) => o.querySelector(".choice-label")?.textContent === p.label)!);
      const checked = feeOptions().filter((o) => o.querySelector("input")?.checked);
      expect(checked.map((o) => o.querySelector(".choice-label")?.textContent)).toEqual([p.label]);
      const body = await submit();
      expect(body.fee_rate).toBe(p.rate);
    });
  }
});
