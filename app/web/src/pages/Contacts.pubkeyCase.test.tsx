// The Contacts page and pubkey case — billing-pubkey-case arc (bitcorn-research
// specs/2026-10-28-billing-pubkey-case-normalization-spec.md: W3, W4, and the
// UI halves of DW-4, DW-10, DW-15, DW-16).
//
// ADD FORM (W3, W4): the Node ID is trimmed, lowercased and refused unless it
// is 66 hex characters starting 02 or 03 — the API's own rule, checked here so
// the reason renders without a round trip. A refused key makes NO API call.
//
// EDIT / DELETE (DW-15, DW-16): each card sends ITS OWN stored pubkey, never
// lowercased and never the tie-break winner's, so a case twin's own row is the
// one acted on (the API's exact-first match). The client URL-encodes it, so a
// legacy value holding a character with meaning in a URL still arrives as
// stored. The URL is read the way it goes on the wire — parsed, so a '#' ends
// the path and a '?' starts the query — then the pubkey segment is decoded.
// The API halves are app/api/src/api/contacts.http.test.ts.
//
// Harness: Contacts.prefill.test.tsx's (createRoot inside act(), no React
// Testing Library). updateContact and deleteContact are the REAL client
// functions over a stubbed fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const REFUSAL = "Node ID must be 66 hexadecimal characters (0-9, a-f), starting with 02 or 03.";

const LOWER = "03" + "c7".repeat(32);
const UPPER = LOWER.toUpperCase();

const stub = vi.hoisted(() => ({
  getContacts: vi.fn(),
  getNode: vi.fn(),
  createContact: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import Contacts from "./Contacts";

type Sent = { url: string; method: string };
let sent: Sent[] = [];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  stub.getContacts.mockResolvedValue([]);
  stub.getNode.mockResolvedValue({ node_role: "treasury" });
  stub.createContact.mockResolvedValue({ ok: true, contact: {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), method: String(init?.method ?? "GET") });
    return { ok: true, status: 200, json: async () => ({ ok: true, contact: {} }) };
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderAt(path: string): Promise<void> {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Contacts)));
  });
  await settle();
}

const inputByPlaceholder = (fragment: string): HTMLInputElement | undefined =>
  Array.from(host.querySelectorAll("input")).find((i) =>
    (i.getAttribute("placeholder") ?? "").includes(fragment),
  ) as HTMLInputElement | undefined;

const buttonByText = (scope: ParentNode, text: string): HTMLButtonElement | undefined =>
  Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement | undefined) {
  expect(el, "the button should be on the page").toBeDefined();
  await act(async () => { el!.click(); });
  await settle();
}

/** Open the add form, enter a Node ID and a name, press Save. */
async function submitAdd(pubkey: string) {
  await renderAt("/contacts");
  await click(buttonByText(host, "+ Add Contact"));
  await type(inputByPlaceholder("Node ID")!, pubkey);
  await type(inputByPlaceholder("Name")!, "Prairie Mill");
  await click(buttonByText(host, "Save"));
}

// ─── Add form ──────────────────────────────────────────────────────────────

describe("DW-4 (UI half): the add form refuses a Node ID that is not 66 hex characters", () => {
  it.each([
    ["65 characters", LOWER.slice(0, 65)],
    ["67 characters", LOWER + "a"],
    ["66 characters, one non-hex", LOWER.slice(0, 65) + "g"],
    ["an internal space", LOWER.slice(0, 30) + " " + LOWER.slice(31)],
    ["empty after trim", "   "],
  ])("%s → the reason is shown and NO API call is made", async (_l, input) => {
    await submitAdd(input);
    expect(stub.createContact, "a refused key must not reach the API").not.toHaveBeenCalled();
    expect(host.textContent).toContain(REFUSAL);
  });

  it("ANTI-VACUITY: a valid key DOES call the API", async () => {
    await submitAdd(LOWER);
    expect(stub.createContact).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(REFUSAL);
  });
});

describe("DW-10 (UI half): the add form refuses a 66-hex key not starting 02 or 03", () => {
  it.each([
    ["04…", "04" + "c7".repeat(32)],
    ["00…", "00" + "c7".repeat(32)],
  ])("%s → the reason is shown and NO API call is made", async (_l, input) => {
    await submitAdd(input);
    expect(stub.createContact).not.toHaveBeenCalled();
    expect(host.textContent).toContain(REFUSAL);
  });

  it.each([
    ["02…", "02" + "c7".repeat(32)],
    ["03…", "03" + "c7".repeat(32)],
  ])("ANTI-VACUITY: a valid %s key DOES call the API", async (_l, input) => {
    await submitAdd(input);
    expect(stub.createContact).toHaveBeenCalledTimes(1);
  });
});

describe("W3: the add form sends the normalized key, and renders the API's 400 reason", () => {
  it("an UPPERCASE key with surrounding whitespace is sent trimmed and lowercase", async () => {
    await submitAdd(`  ${UPPER}  `);
    expect(stub.createContact).toHaveBeenCalledTimes(1);
    expect(stub.createContact.mock.calls[0][0].pubkey).toBe(LOWER);
  });

  it("a 400 from the API (a client that skipped this check) shows the API's own reason", async () => {
    stub.createContact.mockRejectedValue(Object.assign(new Error("name is required"), { status: 400 }));
    await submitAdd(LOWER);
    expect(host.textContent).toContain("name is required");
  });
});

describe("W4: the ?pubkey= prefill", () => {
  it("an UPPERCASE prefill is shown lowercase", async () => {
    await renderAt(`/contacts?pubkey=${UPPER}`);
    expect(inputByPlaceholder("Node ID")!.value).toBe(LOWER);
  });

  it("an invalid prefill is shown with the reason and cannot be submitted", async () => {
    const bad = "04" + "c7".repeat(32);
    await renderAt(`/contacts?pubkey=${bad}`);
    expect(inputByPlaceholder("Node ID")!.value, "the prefill is not dropped or rewritten").toBe(bad);
    expect(host.textContent).toContain(REFUSAL);

    await type(inputByPlaceholder("Name")!, "Prairie Mill");
    await click(buttonByText(host, "Save"));
    expect(stub.createContact).not.toHaveBeenCalled();
  });
});

// ─── Edit / Delete ─────────────────────────────────────────────────────────

const contact = (id: number, pubkey: string, name: string, source: "manual" | "auto") => ({
  id, pubkey, name, notes: null, tags: [], source, created_at: 0, updated_at: 0, channels: [],
});

/** The pubkey segment of a sent URL as the server receives it: the path only, decoded. */
function pubkeySegment(url: string): string | null {
  const pathname = new URL(url, "http://node.local").pathname;
  const raw = pathname.slice("/api/contacts/".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // undecodable — cannot equal any stored value
  }
}

function cardFor(name: string): HTMLElement {
  const card = Array.from(host.querySelectorAll<HTMLElement>(".panel")).find((p) =>
    Array.from(p.querySelectorAll("span")).some((s) => s.textContent === name),
  );
  expect(card, `the card for ${name} should render`).toBeDefined();
  return card!;
}

async function editAndSave(name: string): Promise<Sent> {
  await click(buttonByText(cardFor(name), "edit"));
  await click(buttonByText(host, "Save"));
  const req = sent.filter((s) => s.method === "PATCH").at(-1);
  expect(req, `Save on ${name} should send a PATCH`).toBeDefined();
  return req!;
}

async function deleteAndConfirm(name: string): Promise<Sent> {
  const card = cardFor(name);
  await click(buttonByText(card, "delete"));
  await click(buttonByText(card, "Confirm"));
  const req = sent.filter((s) => s.method === "DELETE").at(-1);
  expect(req, `Confirm on ${name} should send a DELETE`).toBeDefined();
  return req!;
}

describe("DW-15 (UI half): Edit and Delete on each case twin send THAT twin's stored pubkey", () => {
  // Data in GET /api/contacts' name order: the losing (auto) row first.
  const losing = contact(1, LOWER, "Alpha Auto", "auto");
  const manual = contact(2, UPPER, "Zulu Manual", "manual");

  it.each([
    ["the manual row (stored UPPERCASE)", manual],
    ["the losing auto row (stored lowercase)", losing],
  ])("%s: the PATCH and the DELETE carry its own value, byte for byte", async (_l, row) => {
    stub.getContacts.mockResolvedValue([losing, manual]);
    await renderAt("/contacts");

    expect(pubkeySegment((await editAndSave(row.name)).url)).toBe(row.pubkey);
    expect(pubkeySegment((await deleteAndConfirm(row.name)).url)).toBe(row.pubkey);
  });
});

describe("DW-16 (UI half): a legacy row whose stored pubkey needs URL encoding", () => {
  it.each([
    ["a '#'", "02" + "ab".repeat(16) + "#legacy"],
    ["a '%'", "02" + "ab".repeat(16) + "%zz"],
    ["a '?'", "02" + "ab".repeat(16) + "?x=1"],
  ])("stored with %s: Edit/Save and Delete/Confirm reach the server with the stored value", async (_l, stored) => {
    stub.getContacts.mockResolvedValue([contact(1, stored, "Odd Legacy", "manual")]);
    await renderAt("/contacts");

    expect(pubkeySegment((await editAndSave("Odd Legacy")).url), "the PATCH's pubkey segment").toBe(stored);
    expect(pubkeySegment((await deleteAndConfirm("Odd Legacy")).url), "the DELETE's pubkey segment").toBe(stored);
  });
});
