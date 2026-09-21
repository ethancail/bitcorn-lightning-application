// The Contacts add-form prefill — the other half of the roster's unidentified
// marker.
//
// Spec: bitcorn-research/specs/2026-09-21-operator-nudge-for-unidentified-
// enrolled-members-spec.md §2.3 / §4.3 / §7.
//
// ─── WHY THIS FILE EXISTS SEPARATELY FROM THE MARKER TESTS ──────────────────
// The marker test asserts the link's href. That proves the roster emits
// `/contacts?pubkey=…`; it proves NOTHING about whether Contacts reads it.
// The two sides are joined only by the literal string "pubkey", and a rename
// on either side breaks the feature while both files stay green on their own.
// This is the test that pins the param name as a contract.
//
// Per spec §2.3, no prefill path existed before this change — verified at
// f589435 by a repo-wide grep: Contacts.tsx used neither useSearchParams nor
// useLocation. This adds one, in the shape four other pages already use.
//
// ⚠ §8 of the spec flagged that the decision's "needs no change to receive
// this" overclaimed relative to its own cited evidence. It did: existing CRUD
// is not a prefill entry point. This file is the change that was said not to
// be needed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const PUBKEY = "02" + "b".repeat(64);

const stub = vi.hoisted(() => ({
  getContacts: vi.fn(),
  getNode: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import Contacts from "./Contacts";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getContacts.mockResolvedValue([]);
  stub.getNode.mockResolvedValue({ node_role: "treasury" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function renderAt(path: string): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(Contacts),
      ),
    );
  });
  await act(async () => { await Promise.resolve(); });
}

/** Inputs by placeholder — what the operator actually sees, and stable
 *  against the form's DOM order changing. */
const inputByPlaceholder = (fragment: string): HTMLInputElement | undefined =>
  Array.from(host.querySelectorAll("input")).find((i) =>
    (i.getAttribute("placeholder") ?? "").includes(fragment),
  ) as HTMLInputElement | undefined;

describe("Contacts add-form prefill", () => {
  it("arriving at /contacts?pubkey=… opens the add form with the Node ID filled", async () => {
    await renderAt(`/contacts?pubkey=${PUBKEY}`);

    const nodeId = inputByPlaceholder("Node ID");
    expect(nodeId, "the add form should be OPEN — a collapsed form hides the prefill").toBeDefined();
    expect(nodeId!.value).toBe(PUBKEY);
  });

  it("§7 fills the pubkey and NOTHING else — Name and Notes stay empty", async () => {
    await renderAt(`/contacts?pubkey=${PUBKEY}`);

    // Anti-vacuity: assert the prefill landed in the SAME test that asserts
    // the other fields are empty. Without the positive half this passes on a
    // form that never rendered.
    expect(inputByPlaceholder("Node ID")!.value).toBe(PUBKEY);

    const name = inputByPlaceholder("Name");
    expect(name, "the Name field should exist").toBeDefined();
    // A guessed name would invert the decision's point: the operator is being
    // asked to go and find one out, not to confirm an assumption.
    expect(name!.value).toBe("");

    const notes = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(notes, "the Notes field should exist").not.toBeNull();
    expect(notes!.value).toBe("");
  });

  it("PERMITTING CONTROL: a plain /contacts visit is unchanged — form closed, nothing prefilled", async () => {
    await renderAt("/contacts");

    // The form is collapsed, so the Node ID input is not in the DOM at all.
    expect(inputByPlaceholder("Node ID")).toBeUndefined();
    // Positive content alongside the absence, so this cannot pass on a page
    // that failed to render: the page's own search box is always present.
    expect(inputByPlaceholder("Search by name"), "the Contacts page should still render").toBeDefined();
  });
});
