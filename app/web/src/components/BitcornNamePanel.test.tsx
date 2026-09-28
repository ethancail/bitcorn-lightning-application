// BitcornNamePanel — the copy, the rejected message, and what a save triggers.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §9.1, §9.2, §10, §12 P12, P14 (screen half). Decision D8 calls 7-9.
//
// ⚠ THE PERMITTING CONTROL LEADS for the rejected message: a 'rejected'
// status shows it. Every "no message" case below sits beside that positive,
// from the same fixture, so a panel that never shows the message fails.
//
// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §10). Hardcoded here, not imported —
// a test that imports the constant it asserts cannot detect a copy change.
// The visibility line had NO test before this file (spec §12 P12).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const VISIBILITY_LINE =
  "Shared with BitCorn — never published to the Lightning network. Your public alias, below, is published."; // §10 — PROPOSED
const REJECTED = "BitCorn couldn't accept this name."; // §10 — PROPOSED
const OLD_VISIBILITY_LINE_WORD = "Saved on this node only";

const stub = vi.hoisted(() => ({
  getBitcornName: vi.fn(),
  setBitcornName: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import BitcornNamePanel from "./BitcornNamePanel";

let host: HTMLDivElement;
let root: Root;
let nameChangedEvents = 0;
const onNameChanged = () => { nameChangedEvents++; };

beforeEach(() => {
  vi.clearAllMocks();
  nameChangedEvents = 0;
  window.addEventListener("bitcorn:name-changed", onNameChanged);
  stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: null });
  stub.setBitcornName.mockImplementation(async (name: string) => ({ bitcorn_name: name, bitcorn_name_set_at: 2 }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  window.removeEventListener("bitcorn:name-changed", onNameChanged);
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

async function render(): Promise<void> {
  await act(async () => { root.render(React.createElement(BitcornNamePanel)); });
  await flush();
}

async function typeAndSave(value: string): Promise<void> {
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
  await act(async () => { save.click(); });
  await flush();
}

// ═══════════════════════════════════════════════════════════════════════════

describe("P12 — the visibility line is pinned", () => {
  it("says the name is shared with BitCorn, and the old 'on this node only' wording is gone", async () => {
    await render();
    expect(host.textContent).toContain(VISIBILITY_LINE);
    expect(host.textContent).not.toContain(OLD_VISIBILITY_LINE_WORD);
  });
});

describe("P14 (screen half) — the generic rejected message", () => {
  it("PERMITTING: a 'rejected' status for the current name shows the message", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: "rejected" });
    await render();
    expect(host.textContent).toContain(REJECTED);
  });

  it("'accepted' shows no message; paired: the field and name did render", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: "accepted" });
    await render();
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("Green Acres");
    expect(host.textContent).not.toContain(REJECTED);
  });

  // One fresh mount per case: re-rendering a mounted panel would not re-fetch,
  // so a loop over one root would assert the first fixture twice.
  it.each([
    ["field absent (an older member API)", { bitcorn_name: "Green Acres", bitcorn_name_set_at: 1 }],
    ["null (the treasury said nothing about this name)", { bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: null }],
  ])("no status — %s — shows no message", async (_label, read) => {
    stub.getBitcornName.mockResolvedValue(read);
    await render();
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("Green Acres");
    expect(host.textContent).not.toContain(REJECTED);
  });

  it("the message never says WHY", async () => {
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: "rejected" });
    await render();
    const text = (host.textContent ?? "").toLowerCase();
    for (const why of ["block", "reserved", "signature", "invalid", "too long", "taken"]) {
      expect(text, why).not.toContain(why);
    }
  });
});

describe("§9 — what a save triggers on this page", () => {
  it("a successful save dispatches ONE bitcorn:name-changed (the top bar listens)", async () => {
    await render();
    await typeAndSave("Prairie Mill");
    expect(stub.setBitcornName).toHaveBeenCalledWith("Prairie Mill");
    expect(nameChangedEvents).toBe(1);
  });

  it("a FAILED save dispatches nothing", async () => {
    stub.setBitcornName.mockRejectedValue(Object.assign(new Error("invalid_name"), { detail: "Name cannot be empty." }));
    await render();
    await typeAndSave("Prairie Mill");
    expect(stub.setBitcornName).toHaveBeenCalledTimes(1);
    expect(nameChangedEvents).toBe(0);
  });

  it("one delayed re-read after 5s lets a 'rejected' verdict appear in the same visit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    // The treasury has not answered yet at save time…
    await typeAndSave("Prairie Mill");
    expect(host.textContent).not.toContain(REJECTED);
    const readsAfterSave = stub.getBitcornName.mock.calls.length;
    // …and has by the delayed re-read.
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Prairie Mill", bitcorn_name_set_at: 2, treasury_name_status: "rejected" });
    await act(async () => { vi.advanceTimersByTime(4_999); });
    await flush();
    expect(stub.getBitcornName.mock.calls.length, "not before 5s").toBe(readsAfterSave);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(stub.getBitcornName.mock.calls.length, "exactly one re-read").toBe(readsAfterSave + 1);
    expect(host.textContent).toContain(REJECTED);
  });
});
