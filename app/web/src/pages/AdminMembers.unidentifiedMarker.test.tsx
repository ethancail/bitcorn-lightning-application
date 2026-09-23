// The unidentified marker on the admin Members roster.
//
// Spec: bitcorn-research/specs/2026-09-21-operator-nudge-for-unidentified-
// enrolled-members-spec.md §6. Decision 3b81b7e. The trigger is "no contacts
// row" and nothing else (§1.2) — not tier, not payment state, not lane.
//
// ─── WHY EVERY TEST RENDERS ALL THREE ROWS AT ONCE ──────────────────────────
// Spec §6.1: "a suite that only asserts the marker appears on nameless rows
// passes on a component that marks every row." So the fixture is deliberately
// mixed — one named row, one nameless row, one named-via-a-MIXED-CASE-contact
// row — and each test scopes its assertion to one <tr> out of that render.
// The discrimination is what is under test, not the marker's existence.
//
// ─── THE THREE CONTROLS ─────────────────────────────────────────────────────
//   §6.1 permitting control — a row WITH a contact shows the name and NO
//        marker, both halves asserted in the same block. This is the test that
//        has real content; the forbidding one alone would pin nothing.
//   §6.2 anti-vacuity — the forbidding tests assert positive content beside
//        the absence, so they cannot pass against a blank render, a thrown
//        component, or a row that never mounted.
//   §6.3 mixed-case control — a contacts row stored uppercase against a
//        roster pubkey emitted lowercase is THE SAME MEMBER. A case-sensitive
//        absence test marks them unidentified while their name is on screen.
//
// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §5, awaiting Ethan). The strings are
// hardcoded here ON PURPOSE rather than imported from the component: a test
// that imports the constant it asserts cannot detect a copy change at all. If
// Ethan revises the copy, these failing is the correct signal, not a defect.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const MARKER = "Unidentified";   // spec §5 — PROPOSED
const ADD_LINK = "Add contact";  // spec §5 — PROPOSED

// 66-char pubkeys, the real shape. PubkeyCell renders slice(0,8)…slice(-8).
const NAMED     = "02" + "a".repeat(64);
const NAMELESS  = "02" + "b".repeat(64);
const MIXEDCASE = "02" + "c".repeat(64); // roster emits lowercase (PR #308)…
const MIXEDCASE_AS_STORED = "02" + "C".repeat(64); // …contacts stored as entered

const short = (pk: string) => `${pk.slice(0, 8)}…${pk.slice(-8)}`;

const row = (pubkey: string) => ({
  member_pubkey: pubkey,
  lane_purpose: "merchant_lane" as const,
  subscription_state: "current" as const,
  current_tier: null,
  paid_through: null,
  last_payment_at: null,
  last_payment_amount_sats: null,
});

const MEMBERS = {
  fetched_at: 1789646400000,
  members: [row(NAMED), row(NAMELESS), row(MIXEDCASE)],
  totals: { total_members: 3, by_state: {} as any },
};

const contact = (pubkey: string, name: string) => ({
  pubkey,
  name,
  notes: "",
  tags: [] as string[],
  source: "manual",
  created_at: 0,
  updated_at: 0,
});

const CONTACTS = [
  contact(NAMED, "Green Acres Farm"),
  contact(MIXEDCASE_AS_STORED, "Prairie Mill"),
  // NAMELESS deliberately absent — that is the whole trigger (§1.2).
];

const stub = vi.hoisted(() => ({
  getAdminMembers: vi.fn(),
  getContacts: vi.fn(),
  getAdminSubscriptionRevenue: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import AdminMembers from "./AdminMembers";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getAdminMembers.mockResolvedValue(MEMBERS);
  stub.getContacts.mockResolvedValue(CONTACTS);
  stub.getAdminSubscriptionRevenue.mockResolvedValue({ members: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function renderRoster(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(AdminMembers)));
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/** The <tr> for a pubkey. Found by the truncated pubkey the cell renders —
 *  NOT by index: the roster sorts by paid_through, so row order is not
 *  fixture order. Throws rather than returning undefined so a missing row
 *  fails loudly instead of collapsing into a vacuous pass. */
function rowFor(pubkey: string): HTMLTableRowElement {
  const found = Array.from(host.querySelectorAll("tbody tr")).find((tr) =>
    (tr.textContent ?? "").includes(short(pubkey)),
  );
  if (!found) {
    throw new Error(
      `no <tr> rendered the truncated pubkey ${short(pubkey)}; ` +
        `tbody had ${host.querySelectorAll("tbody tr").length} row(s)`,
    );
  }
  return found as HTMLTableRowElement;
}

describe("unidentified marker — spec §6", () => {
  it("§6.1 PERMITTING CONTROL: a row WITH a contact shows the name and NO marker", async () => {
    await renderRoster();
    const text = rowFor(NAMED).textContent ?? "";

    // Both halves, same block. The positive half is what makes the negative
    // half mean something — without it this passes on a row that never
    // rendered a Member cell at all.
    expect(text, "the resolved contact name should render").toContain("Green Acres Farm");
    expect(text, "a NAMED row must not be nudged as unidentified").not.toContain(MARKER);
    expect(text, "a NAMED row must not offer the add-contact link").not.toContain(ADD_LINK);
  });

  it("§6.2 the nameless row shows the marker AND keeps the pubkey visible", async () => {
    await renderRoster();
    const tr = rowFor(NAMELESS);
    const text = tr.textContent ?? "";

    expect(text).toContain(MARKER);
    // Anti-vacuity + spec §4.2: "Keep the pubkey visible. It is the only
    // durable handle the operator has on an unnamed row." The marker
    // ACCOMPANIES the pubkey; it must not replace it.
    expect(text, "the truncated pubkey must survive beside the marker").toContain(short(NAMELESS));
  });

  it("§4.3 the marker links into Contacts with the pubkey prefilled, and nothing else", async () => {
    await renderRoster();
    const link = rowFor(NAMELESS).querySelector("a");
    expect(link, "the nameless row should carry a link affordance").not.toBeNull();
    expect(link!.textContent).toContain(ADD_LINK);

    const href = link!.getAttribute("href") ?? "";
    expect(href).toContain("/contacts");
    // The FULL pubkey, not the truncated display form — the prefill has to be
    // usable, and `short()` would silently produce an unsaveable contact.
    expect(href).toContain(NAMELESS);
    // Spec §7: "Name only the pubkey." A prefilled name would invert the
    // decision's entire point — the operator must go and find one out.
    expect(href).not.toMatch(/[?&]name=/);
    expect(href).not.toMatch(/[?&]notes=/);
  });

  it("§6.3 MIXED-CASE CONTROL: an uppercase-stored contact against a lowercase roster pubkey resolves to the NAME", async () => {
    await renderRoster();
    const text = rowFor(MIXEDCASE).textContent ?? "";

    // The treasury HOLDS this name. A case-sensitive absence test would miss
    // the contacts row and nudge the operator to go find a name already on
    // screen — §3's headline failure, and in its sharpest form the row would
    // render the name AND the marker at once.
    expect(text, "the mixed-case contact should resolve").toContain("Prairie Mill");
    expect(text, "a member the treasury CAN name must not be marked").not.toContain(MARKER);
  });

  it("marks exactly ONE of the three rows — the component does not mark every row", async () => {
    await renderRoster();
    const marked = Array.from(host.querySelectorAll("tbody tr")).filter((tr) =>
      (tr.textContent ?? "").includes(MARKER),
    );
    expect(marked, "only the row with no contacts row should be marked").toHaveLength(1);
    expect(marked[0].textContent).toContain(short(NAMELESS));
  });
});

// ─── The contacts READ FAILURE, which is not the same as "nobody is named" ──
//
// The marker means exactly one thing (spec §1.2): enrolled, and the treasury
// holds no name. A failed contacts read means the treasury does not KNOW
// whether it holds a name — so the marker must say nothing at all, and the
// row falls back to the pre-marker display.
//
// ⚠ The distinction under test is FETCH-FAILED vs FETCH-SUCCEEDED-EMPTY, not
// empty vs non-empty. A successful read returning zero contacts is a truthful
// "nobody is named" and must still mark every row — which is what the
// permitting control below pins. Suppressing on emptiness instead of on
// failure would satisfy the forbidding test and quietly break the feature's
// most common first-run state.

const markedRows = (): HTMLTableRowElement[] =>
  Array.from(host.querySelectorAll("tbody tr")).filter((tr) =>
    (tr.textContent ?? "").includes(MARKER),
  ) as HTMLTableRowElement[];

describe("contacts read failure vs empty contacts", () => {
  it("PERMITTING CONTROL: a SUCCESSFUL read returning an empty array still marks every row", async () => {
    stub.getContacts.mockResolvedValue([]);
    await renderRoster();

    // Positive content first: the rows are actually here. Without this the
    // length check below could be satisfied by a table that never rendered.
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(
      markedRows(),
      "an empty-but-successful read is a truthful 'nobody is named' — all three rows qualify",
    ).toHaveLength(3);
  });

  it("FORBIDDING: a FAILED read marks NO row, and the pubkeys still render", async () => {
    stub.getContacts.mockRejectedValue(
      Object.assign(new Error("contacts unreachable"), { status: 500 }),
    );
    await renderRoster();

    expect(
      markedRows(),
      "the roster must not assert the treasury has identified nobody when it could not read contacts",
    ).toHaveLength(0);

    // Anti-vacuity — "no marker" passes against a blank render, an error
    // boundary, a thrown component, and a table that never mounted. The
    // pre-marker display is what must survive, so assert it directly.
    const text = host.textContent ?? "";
    for (const pk of [NAMED, NAMELESS, MIXEDCASE]) {
      expect(text, `the pubkey for ${short(pk)} must still render`).toContain(short(pk));
    }
    expect(host.querySelectorAll("tbody tr"), "all three rows still render").toHaveLength(3);
  });

  it("FORBIDDING: a FAILED read offers no add-contact link either", async () => {
    stub.getContacts.mockRejectedValue(new Error("contacts unreachable"));
    await renderRoster();

    expect(host.textContent ?? "").not.toContain(ADD_LINK);
    // Anti-vacuity: the table is present, so the absence is meaningful.
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});
