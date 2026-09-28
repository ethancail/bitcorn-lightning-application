// The roster's Member-set name column, and D4's marker on ANY name the
// treasury holds.
//
// Spec: bitcorn-research specs/2026-09-25-member-name-signed-transport-spec.md
// §8.1, §8.2 (the four-arm composition), §10, §12 P10. Decision D8 call 6.
//
// ─── WHY THE PERMITTING CONTROL LEADS ───────────────────────────────────────
// Every fallback state below ("not set", "—", no marker) is something the
// component can emit without ever reading a private name. The first test is
// the one that says the column shows one.
//
// ─── WHY EVERY TEST RENDERS ALL ROWS AT ONCE ───────────────────────────────
// The fixture is deliberately mixed, and each "no marker" assertion sits
// beside a row in the SAME render that IS marked — so a component that never
// marks, or marks every row, fails. The discrimination is what is under test.
//
// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §10). Hardcoded here on purpose, not
// imported: a test that imports the constant it asserts cannot detect a copy
// change.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const COLUMN = "Member-set name"; //              §10 — PROPOSED
const NOT_SET = "not set"; //                      §10 — PROPOSED
const READ_FAILED_CELL = "—"; //                   §10 — PROPOSED
const READ_FAILED_HEADER = "unavailable"; //       §10 — PROPOSED
const MARKER = "Unidentified"; //                  D4 spec §5 — PROPOSED
const ADD_LINK = "Add contact"; //                 D4 spec §5 — PROPOSED

const pk = (c: string) => "03" + c.repeat(64);
const PRIVATE_ONLY = pk("1"); //    member-set name only — no contact, alias "none announced"
const NOBODY = pk("2"); //          nothing anywhere; alias "none announced"
const CONTACT_AND_PRIVATE = pk("3"); // a contact AND a different member-set name
const STALE_ALIAS = pk("4"); //     a real alias kept after a FAILED last lookup; no private name
const NOT_IN_GRAPH = pk("5"); //    "no public channel" only
const UNCHECKED = pk("6"); //       no alias row at all, no private name
// A LETTER, not a digit: "7".toUpperCase() is "7", which would make the
// mixed-case control compare a key against itself and pass vacuously.
const MIXEDCASE = pk("e"); //       member-set name stored uppercase-keyed

const short = (k: string) => `${k.slice(0, 8)}…${k.slice(-8)}`;

const memberRow = (pubkey: string) => ({
  member_pubkey: pubkey,
  lane_purpose: "merchant_lane" as const,
  subscription_state: "current" as const,
  current_tier: null,
  paid_through: null,
  last_payment_at: null,
  last_payment_amount_sats: null,
});

const ALL = [PRIVATE_ONLY, NOBODY, CONTACT_AND_PRIVATE, STALE_ALIAS, NOT_IN_GRAPH, UNCHECKED, MIXEDCASE];
const MEMBERS = {
  fetched_at: 1789646400000,
  members: ALL.map(memberRow),
  totals: { total_members: ALL.length, by_state: {} as any },
};

const CONTACTS = [
  { pubkey: CONTACT_AND_PRIVATE, name: "Lazy H", notes: "", tags: [], source: "manual", created_at: 0, updated_at: 0 },
];

const nameRow = (pubkey: string, name: string) => ({ pubkey, name, signed_at: 1790000000, received_at: 1790000001 });
const NAMES = [
  nameRow(PRIVATE_ONLY, "Green Acres"),
  nameRow(CONTACT_AND_PRIVATE, "Lazy H Farms LLC"),
  nameRow(MIXEDCASE.toUpperCase(), "Prairie Mill"),
];

const aliasRow = (pubkey: string, outcome: string | null, alias: string | null, last_attempt_ok = 1) => ({
  pubkey,
  outcome,
  alias,
  outcome_at: outcome === null ? null : 1789646000000,
  last_attempt_at: 1789646300000,
  last_attempt_ok,
});
const ALIASES = [
  aliasRow(PRIVATE_ONLY, "none_announced", null),
  aliasRow(NOBODY, "none_announced", null),
  aliasRow(STALE_ALIAS, "alias", "Old Mill", 0),
  aliasRow(NOT_IN_GRAPH, "not_in_graph", null),
];

const stub = vi.hoisted(() => ({
  getAdminMembers: vi.fn(),
  getContacts: vi.fn(),
  getAdminSubscriptionRevenue: vi.fn(),
  getAdminPublicAliases: vi.fn(),
  getAdminPrivateNames: vi.fn(),
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
  stub.getAdminPublicAliases.mockResolvedValue({ aliases: ALIASES });
  stub.getAdminPrivateNames.mockResolvedValue({ names: NAMES });
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
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

function rowFor(pubkey: string): HTMLTableRowElement {
  const found = Array.from(host.querySelectorAll("tbody tr")).find((tr) =>
    (tr.textContent ?? "").includes(short(pubkey)),
  );
  if (!found) throw new Error(`no <tr> rendered ${short(pubkey)}`);
  return found as HTMLTableRowElement;
}

function header(): HTMLTableCellElement {
  const th = Array.from(host.querySelectorAll("thead th")).find((h) => (h.textContent ?? "").includes(COLUMN));
  if (!th) throw new Error(`no "${COLUMN}" column header rendered`);
  return th as HTMLTableCellElement;
}

function cell(pubkey: string): string {
  const idx = Array.from(host.querySelectorAll("thead th")).indexOf(header());
  const c = rowFor(pubkey).cells[idx];
  if (!c) throw new Error(`row ${short(pubkey)} has no cell at column ${idx}`);
  return (c.textContent ?? "").trim();
}

const marked = (pubkey: string) => (rowFor(pubkey).textContent ?? "").includes(MARKER);

// ═══════════════════════════════════════════════════════════════════════════

describe("§8.1 PERMITTING CONTROL — a member-set name shows in its own column", () => {
  it("the cell renders the name the treasury holds", async () => {
    await renderRoster();
    expect(cell(PRIVATE_ONLY)).toBe("Green Acres");
  });

  it("the column sits between Member and Public alias", async () => {
    await renderRoster();
    const headers = Array.from(host.querySelectorAll("thead th")).map((h) => (h.textContent ?? "").trim());
    const idx = headers.findIndex((h) => h.startsWith(COLUMN));
    expect(headers[idx - 1]).toMatch(/^Member\b/);
    expect(headers[idx + 1]).toContain("Public alias");
  });

  it("every cell state: name / not set, and a mixed-case key still resolves", async () => {
    await renderRoster();
    expect(cell(CONTACT_AND_PRIVATE)).toBe("Lazy H Farms LLC");
    expect(cell(MIXEDCASE)).toBe("Prairie Mill");
    for (const k of [NOBODY, STALE_ALIAS, NOT_IN_GRAPH, UNCHECKED]) expect(cell(k), short(k)).toBe(NOT_SET);
    expect(header().textContent).not.toContain(READ_FAILED_HEADER);
  });

  it("the Member column is unchanged: a contact name stays there; the member-set name does not leak in", async () => {
    await renderRoster();
    const memberCell = rowFor(CONTACT_AND_PRIVATE).cells[0].textContent ?? "";
    expect(memberCell).toContain("Lazy H");
    expect(memberCell).not.toContain("Lazy H Farms LLC");
    expect(rowFor(PRIVATE_ONLY).cells[0].textContent ?? "", "no private name in the Member cell").not.toContain("Green Acres");
  });
});

describe("P10 — D4's marker clears on ANY name the treasury holds (D8 call 6)", () => {
  it("a member with ONLY a private name — no contact — is NOT marked, and has no Add-contact link", async () => {
    await renderRoster();
    const tr = rowFor(PRIVATE_ONLY);
    expect(tr.textContent).not.toContain(MARKER);
    expect(tr.textContent).not.toContain(ADD_LINK);
    // Anti-vacuity, same render: the bare pubkey is there, and the nameless
    // row IS marked — so this is discrimination, not a component that never marks.
    expect(tr.cells[0].textContent).toContain(short(PRIVATE_ONLY));
    expect(marked(NOBODY)).toBe(true);
  });

  it("a mixed-case-keyed private name clears the marker too", async () => {
    // Anti-vacuity on the fixture itself: the stored key really differs.
    expect(MIXEDCASE.toUpperCase()).not.toBe(MIXEDCASE);
    await renderRoster();
    expect(marked(MIXEDCASE)).toBe(false);
    expect(marked(NOBODY)).toBe(true);
  });

  it("a STALE real alias (last lookup failed) counts as a name — it is the last good value (D7 §3)", async () => {
    await renderRoster();
    expect(marked(STALE_ALIAS)).toBe(false);
    expect(marked(NOBODY)).toBe(true);
  });

  it("'none announced', 'no public channel' and 'not checked yet' are NOT names — each still marks", async () => {
    await renderRoster();
    expect(marked(NOBODY), "none announced").toBe(true);
    expect(marked(NOT_IN_GRAPH), "no public channel").toBe(true);
    expect(marked(UNCHECKED), "not checked yet").toBe(true);
  });

  it("exactly the three nameless rows are marked — not every row, not none", async () => {
    await renderRoster();
    const markedRows = ALL.filter(marked).map(short).sort();
    expect(markedRows).toEqual([NOBODY, NOT_IN_GRAPH, UNCHECKED].map(short).sort());
  });
});

describe("§8.2 arm 4 — a FAILED read means no claim (unknown), never the marker", () => {
  it("private-name read fails → header 'unavailable', cells '—', NO marker anywhere; the roster survives", async () => {
    stub.getAdminPrivateNames.mockRejectedValue(Object.assign(new Error("unreachable"), { status: 500 }));
    await renderRoster();
    expect(host.querySelectorAll("tbody tr")).toHaveLength(ALL.length);
    expect(header().textContent).toContain(READ_FAILED_HEADER);
    for (const k of ALL) expect(cell(k), short(k)).toBe(READ_FAILED_CELL);
    expect(host.textContent).not.toContain(NOT_SET);
    expect(host.textContent, "no row can be claimed nameless").not.toContain(MARKER);
    // Anti-vacuity: the contact name still resolves — only the claim is withheld.
    expect(rowFor(CONTACT_AND_PRIVATE).cells[0].textContent).toContain("Lazy H");
  });

  it("PERMITTING HALF: a SUCCESSFUL empty read shows 'not set' everywhere, header normal, and marks the nameless", async () => {
    stub.getAdminPrivateNames.mockResolvedValue({ names: [] });
    await renderRoster();
    for (const k of ALL) expect(cell(k)).toBe(NOT_SET);
    expect(header().textContent).not.toContain(READ_FAILED_HEADER);
    expect(marked(PRIVATE_ONLY), "with no private name it is nameless again").toBe(true);
  });

  it("contacts read fails but a private name exists → that row is still named-elsewhere; a nameless row is unknown", async () => {
    stub.getContacts.mockRejectedValue(new Error("contacts unreachable"));
    await renderRoster();
    expect(cell(PRIVATE_ONLY)).toBe("Green Acres");
    expect(host.textContent).not.toContain(MARKER);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(ALL.length);
  });
});

describe("search matches the member-set name (spec §8.1, PROPOSED)", () => {
  it("typing part of it, in any case, filters to that row", async () => {
    await renderRoster();
    const input = host.querySelector("input.admin-members-search") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "green ac");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    const rows = Array.from(host.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(short(PRIVATE_ONLY));
  });
});
