// BitcornNamePanel — the copy, the rejected message, and what a save triggers.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §9.1, §9.2, §10, §12 P12, P14 (screen half). Decision D8 calls 7-9.
//
// ⚠ THE PERMITTING CONTROL LEADS for the rejected message: a 'rejected'
// status shows it. Every "no message" case below sits beside that positive,
// from the same fixture, so a panel that never shows the message fails.
//
// ⚠ COPY IS ACCEPTED (Ethan, 2026-09-28) and hardcoded here, not imported —
// a test that imports the constant it asserts cannot detect a copy change.
// The rejected message's "Try a different one." was Ethan's one change; this
// file went red against the old string before the constant was updated.
// The visibility line had NO test before this file (spec §12 P12).
//
// ⚠ The settings-name-clarity copy (Ethan's four yeses, 2026-09-29) is
// ACCEPTED as built (Ethan, 2026-09-29) — hardcoded below for the same
// reason. The save
// helper finds the button by "Save name"; the three §9 tests that use it went
// red against the old bare "Save" before the component changed, so the helper
// is proven to find the renamed button and not a stale one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { bitcornNameInputState } from "./bitcornNameInputState";

const VISIBILITY_LINE =
  "Shared with BitCorn — never published to the Lightning network. Your public alias, below, is published."; // ACCEPTED — Ethan, 2026-09-28
const REJECTED = "BitCorn couldn't accept this name. Try a different one."; // ACCEPTED — Ethan, 2026-09-28
const OLD_VISIBILITY_LINE_WORD = "Saved on this node only";
const SAVE_NAME = "Save name"; // ACCEPTED — Ethan, 2026-09-29
const UNSET_LINE = "Not set yet"; // ACCEPTED — Ethan, 2026-09-29
const NAME_PLACEHOLDER = 'e.g. "Cedar Creek Grain"'; // ACCEPTED — Ethan, 2026-09-29
const ALIAS_PLACEHOLDER = 'e.g. "Lazy Acres Farm"'; // ProfilePanel's — must not be duplicated here
const UNSET_READ = { bitcorn_name: null, bitcorn_name_set_at: null, treasury_name_status: null };

const stub = vi.hoisted(() => ({
  getBitcornName: vi.fn(),
  setBitcornName: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import BitcornNamePanel, { NAME_FIELD_LANDING_WINDOW_MS } from "./BitcornNamePanel";

let host: HTMLDivElement;
let root: Root;
let nameChangedEvents = 0;
const onNameChanged = () => { nameChangedEvents++; };
// jsdom implements no layout, so no scrollIntoView; `this` of each call is
// recorded in scrollIntoView.mock.contexts.
const scrollIntoView = vi.fn();
// Nor ResizeObserver. This one records what is observed and lets a test fire
// "the page's layout changed" by hand — and, like the real one, delivers
// nothing once disconnected.
const resize = { callbacks: [] as Array<() => void>, observed: [] as Element[], disconnected: 0 };
class FakeResizeObserver {
  private connected = true;
  constructor(private cb: () => void) { resize.callbacks.push(() => { if (this.connected) this.cb(); }); }
  observe(el: Element) { resize.observed.push(el); }
  disconnect() { this.connected = false; resize.disconnected++; }
  unobserve() {}
}
const layoutChanged = async () => {
  await act(async () => { resize.callbacks.forEach((cb) => cb()); });
};

beforeEach(() => {
  vi.clearAllMocks();
  nameChangedEvents = 0;
  Element.prototype.scrollIntoView = scrollIntoView;
  resize.callbacks = [];
  resize.observed = [];
  resize.disconnected = 0;
  (globalThis as any).ResizeObserver = FakeResizeObserver;
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
  delete (Element.prototype as any).scrollIntoView;
  delete (globalThis as any).ResizeObserver;
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

async function render(props: { focusOnMount?: boolean } = {}): Promise<void> {
  await act(async () => { root.render(React.createElement(BitcornNamePanel, props)); });
  await flush();
}

const buttonsLabelled = (text: string) =>
  Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === text);

async function typeAndSave(value: string): Promise<void> {
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = buttonsLabelled(SAVE_NAME)[0];
  if (!save) throw new Error(`no button labelled "${SAVE_NAME}"`);
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

// ─── settings-name-clarity (Ethan, 2026-09-29) — copy ACCEPTED ─────────────

describe("settings-name-clarity — the renamed button still saves", () => {
  it("PERMITTING: the one 'Save name' button stores the name and triggers the one refresh", async () => {
    await render();
    expect(buttonsLabelled(SAVE_NAME)).toHaveLength(1);
    const readsBefore = stub.getBitcornName.mock.calls.length;
    await typeAndSave("Prairie Mill");
    expect(stub.setBitcornName).toHaveBeenCalledTimes(1);
    expect(stub.setBitcornName).toHaveBeenCalledWith("Prairie Mill");
    expect(nameChangedEvents, "one bitcorn:name-changed").toBe(1);
    expect(stub.getBitcornName.mock.calls.length, "re-read after the save").toBe(readsBefore + 1);
  });

  it("the button says 'Save name', and no bare 'Save' button is left", async () => {
    await render();
    expect(buttonsLabelled(SAVE_NAME)).toHaveLength(1);
    expect(buttonsLabelled("Save")).toHaveLength(0);
  });
});

describe("settings-name-clarity — the unset state", () => {
  it("no name stored → 'Not set yet' and the placeholder", async () => {
    stub.getBitcornName.mockResolvedValue(UNSET_READ);
    await render();
    expect(host.textContent).toContain(UNSET_LINE);
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(NAME_PLACEHOLDER);
  });

  it("a name stored → no 'Not set yet'; paired: the field shows that name", async () => {
    await render();
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("Green Acres");
    expect(host.textContent).not.toContain(UNSET_LINE);
  });

  it("it goes away once a name is saved, in the same visit", async () => {
    stub.getBitcornName.mockResolvedValueOnce(UNSET_READ);
    stub.getBitcornName.mockResolvedValue({ bitcorn_name: "Prairie Mill", bitcorn_name_set_at: 2, treasury_name_status: null });
    await render();
    expect(host.textContent).toContain(UNSET_LINE);
    await typeAndSave("Prairie Mill");
    expect(host.textContent).not.toContain(UNSET_LINE);
  });

  it("a FAILED read is not 'not set' — unknown is not unset", async () => {
    stub.getBitcornName.mockRejectedValue(new Error("network"));
    await render();
    expect(host.textContent).toContain("Couldn't load your name");
    expect(host.textContent).not.toContain(UNSET_LINE);
  });

  it("the placeholder does not duplicate the alias field's, and its example is itself a valid name", async () => {
    stub.getBitcornName.mockResolvedValue(UNSET_READ);
    await render();
    const placeholder = (host.querySelector("input") as HTMLInputElement).placeholder;
    expect(placeholder.length).toBeGreaterThan(0);
    expect(placeholder).not.toBe(ALIAS_PLACEHOLDER);
    expect(placeholder).not.toContain("Lazy Acres");
    const example = placeholder.match(/"([^"]+)"/)?.[1] ?? "";
    expect(bitcornNameInputState(example).valid, example).toBe(true);
  });
});

describe("settings-name-clarity — the deep link lands on the field", () => {
  it("focusOnMount → the name field is focused and scrolled into view", async () => {
    await render({ focusOnMount: true });
    const input = host.querySelector("input") as HTMLInputElement;
    expect(document.activeElement, "focused").toBe(input);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0], "scrolled the field itself").toBe(input);
  });

  it("paired: without focusOnMount, nothing is focused or scrolled", async () => {
    await render();
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("Green Acres");
    expect(document.activeElement).not.toBe(host.querySelector("input"));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("it waits for the name read, so the collapsing 'Loading…' line cannot move the field after the scroll", async () => {
    let resolveRead!: (v: unknown) => void;
    stub.getBitcornName.mockImplementation(() => new Promise((r) => { resolveRead = r; }));
    await render({ focusOnMount: true });
    expect(host.textContent).toContain("Loading…");
    expect(scrollIntoView, "not while loading").not.toHaveBeenCalled();
    await act(async () => { resolveRead({ bitcorn_name: "Green Acres", bitcorn_name_set_at: 1, treasury_name_status: null }); });
    await flush();
    expect(host.textContent).not.toContain("Loading…");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host.querySelector("input"));
  });

  it("only once: a later save does not re-scroll", async () => {
    await render({ focusOnMount: true });
    await typeAndSave("Prairie Mill");
    expect(stub.setBitcornName).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

// Measured in a real browser at 500×700, not assumed: the subscription and
// auto-pay panels above load on their own reads, and when they finish AFTER
// the name read they grew ~970px and left the focused field far below the
// fold. One scroll cannot land on a page still growing above its target.
describe("settings-name-clarity — it keeps landing while the page above still grows", () => {
  it("PERMITTING: a layout change after landing re-lands the field", async () => {
    await render({ focusOnMount: true });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(resize.observed, "watches the page that holds this panel").toContain(host);
    await layoutChanged();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(host.querySelector("input"));
  });

  it.each(["wheel", "touchstart", "keydown", "pointerdown"])(
    "stops once the member acts themselves (%s) — it never fights them",
    async (type) => {
      await render({ focusOnMount: true });
      await act(async () => { window.dispatchEvent(new Event(type)); });
      await layoutChanged();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(resize.disconnected).toBeGreaterThan(0);
    },
  );

  it("stops after the landing window even if nobody acts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ focusOnMount: true });
    await act(async () => { vi.advanceTimersByTime(NAME_FIELD_LANDING_WINDOW_MS); });
    await layoutChanged();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("without focusOnMount nothing is watched", async () => {
    await render();
    expect(resize.observed).toHaveLength(0);
  });

  it("unmounting stops the watch", async () => {
    await render({ focusOnMount: true });
    await act(async () => { root.unmount(); });
    expect(resize.disconnected).toBeGreaterThan(0);
    root = createRoot(host); // afterEach unmounts again
  });
});
