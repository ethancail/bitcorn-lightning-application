// The roster's Public alias column and its refresh button.
//
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §7, §8,
// §10, §11 controls 1, 2, 3, 8 and 11 (roster half). Decision D7.
//
// ─── WHY THE PERMITTING CONTROL LEADS ───────────────────────────────────────
// §11.1: "a suite asserting only the fallbacks passes on a column that never
// shows an alias." Every fallback state below is a string the component can
// emit without ever reading an alias; the first test is the one that says the
// column does its job.
//
// ─── THE PUBLIC ALIAS IS NOT A NAME THE TREASURY HOLDS ─────────────────────
// D4's Unidentified marker fires on "no contacts row", and this column must not
// change that: a member whose node announces a public alias, but whom the
// treasury has not named, is STILL unidentified. The D4 block below pins it.
//
// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §10). Hardcoded here on purpose, not
// imported from the component — a test that imports the constant it asserts
// cannot detect a copy change. If Ethan revises the copy, these failing is the
// correct signal.
//
// ⚠ PRE-CHANGE RUN: run against 30de308 before the column existed. Red there —
// no "Public alias" header to find.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const COLUMN = "Public alias"; //                          §10 — PROPOSED
const NONE_ANNOUNCED = "none announced"; //                §10 — PROPOSED
const NOT_IN_GRAPH = "no public channel"; //               §10 — PROPOSED
const NOT_CHECKED = "not checked yet"; //                  §10 — PROPOSED
const READ_FAILED_CELL = "—"; //                           §10 — PROPOSED
const READ_FAILED_HEADER = "unavailable"; //               §10 — PROPOSED
const REFRESH_BUTTON = "Refresh public aliases"; //        §10 — PROPOSED
const REFRESH_RESULT =
  "Checked 4: 1 with an alias, 1 none announced, 1 no public channel, 1 lookups failed."; // §10 — PROPOSED
const REFRESH_IN_PROGRESS = "A public alias refresh is already running."; // NOT in §10 — implementer's PROPOSAL
const REFRESH_FAILED = "Public alias refresh failed"; //  NOT in §10 — implementer's PROPOSAL
const MARKER = "Unidentified"; //                          D4 spec §5 — PROPOSED

const pk = (c: string) => "02" + c.repeat(64);
const HAS_ALIAS = pk("a"); //      announces "Lazy H Farms"; named by the treasury as something else
const NONE = pk("b"); //           none announced; no contact
const NIG = pk("c"); //            not in the graph
const UNCHECKED = pk("d"); //      no store row at all
const FAILED_ONLY = pk("e"); //    a first-ever failure: row with outcome NULL
const ALIAS_NO_CONTACT = pk("f"); // announces an alias; the treasury holds NO name

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

const ALL = [HAS_ALIAS, NONE, NIG, UNCHECKED, FAILED_ONLY, ALIAS_NO_CONTACT];
const MEMBERS = {
  fetched_at: 1789646400000,
  members: ALL.map(memberRow),
  totals: { total_members: ALL.length, by_state: {} as any },
};

const CONTACTS = [
  { pubkey: HAS_ALIAS, name: "Green Acres Farm", notes: "", tags: [], source: "manual", created_at: 0, updated_at: 0 },
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
  aliasRow(HAS_ALIAS, "alias", "Lazy H Farms"),
  aliasRow(NONE, "none_announced", null),
  aliasRow(NIG, "not_in_graph", null),
  aliasRow(FAILED_ONLY, null, null, 0),
  aliasRow(ALIAS_NO_CONTACT, "alias", "Prairie Mill"),
  // UNCHECKED deliberately absent.
];

const stub = vi.hoisted(() => ({
  getAdminMembers: vi.fn(),
  getContacts: vi.fn(),
  getAdminSubscriptionRevenue: vi.fn(),
  getAdminPublicAliases: vi.fn(),
  refreshAdminPublicAliases: vi.fn(),
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
  stub.refreshAdminPublicAliases.mockResolvedValue({
    ok: true,
    total: 4,
    alias: 1,
    none_announced: 1,
    not_in_graph: 1,
    failed: 1,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
};

async function renderRoster(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(AdminMembers)));
  });
  await flush();
}

function rowFor(pubkey: string): HTMLTableRowElement {
  const found = Array.from(host.querySelectorAll("tbody tr")).find((tr) =>
    (tr.textContent ?? "").includes(short(pubkey)),
  );
  if (!found) throw new Error(`no <tr> rendered ${short(pubkey)}`);
  return found as HTMLTableRowElement;
}

/** The Public alias <th>. Throws if absent — a missing column must fail loudly. */
function aliasHeader(): HTMLTableCellElement {
  const th = Array.from(host.querySelectorAll("thead th")).find((h) =>
    (h.textContent ?? "").includes(COLUMN),
  );
  if (!th) throw new Error(`no "${COLUMN}" column header rendered`);
  return th as HTMLTableCellElement;
}

/** The Public alias cell for a row, located by the header's column index. */
function aliasCell(pubkey: string): string {
  const idx = Array.from(host.querySelectorAll("thead th")).indexOf(aliasHeader());
  const cell = rowFor(pubkey).cells[idx];
  if (!cell) throw new Error(`row ${short(pubkey)} has no cell at column ${idx}`);
  return (cell.textContent ?? "").trim();
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(host.querySelectorAll("button")).find((x) => (x.textContent ?? "").includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("§11.1 PERMITTING CONTROL — a real alias shows", () => {
  it("the Public alias cell renders the announced alias", async () => {
    await renderRoster();
    expect(aliasCell(HAS_ALIAS)).toBe("Lazy H Farms");
  });

  it("the column sits immediately right of Member (spec §8.1)", async () => {
    await renderRoster();
    const headers = Array.from(host.querySelectorAll("thead th")).map((h) => (h.textContent ?? "").trim());
    const member = headers.findIndex((h) => h.startsWith("Member"));
    expect(member).toBeGreaterThanOrEqual(0);
    expect(headers[member + 1]).toContain(COLUMN);
  });
});

describe("§11.2 every state renders distinctly", () => {
  it("alias / none announced / no public channel / not checked yet (no row) / not checked yet (outcome NULL)", async () => {
    await renderRoster();
    expect(aliasCell(HAS_ALIAS)).toBe("Lazy H Farms");
    expect(aliasCell(NONE)).toBe(NONE_ANNOUNCED);
    expect(aliasCell(NIG)).toBe(NOT_IN_GRAPH);
    expect(aliasCell(UNCHECKED)).toBe(NOT_CHECKED);
    expect(aliasCell(FAILED_ONLY), "a first-ever failure has learned nothing: not yet known").toBe(NOT_CHECKED);
    // Anti-vacuity: the header is NOT in its read-failed state here.
    expect(aliasHeader().textContent).not.toContain(READ_FAILED_HEADER);
  });

  it("the Member column is unchanged: the contact name stays there, apart from the public alias", async () => {
    await renderRoster();
    const tr = rowFor(HAS_ALIAS);
    const memberCellText = tr.cells[0].textContent ?? "";
    expect(memberCellText).toContain("Green Acres Farm");
    expect(memberCellText, "the public alias must not leak into the Member column").not.toContain("Lazy H Farms");
  });
});

describe("§11.3 a failed LAST attempt over a definitive outcome renders the outcome", () => {
  it("alias stored, last attempt failed → still the alias", async () => {
    stub.getAdminPublicAliases.mockResolvedValue({ aliases: [aliasRow(HAS_ALIAS, "alias", "Lazy H Farms", 0)] });
    await renderRoster();
    expect(aliasCell(HAS_ALIAS)).toBe("Lazy H Farms");
  });
});

describe("D4 PRESERVED — the public alias is not a name the treasury holds", () => {
  it("a member announcing a public alias but with NO contacts row is still marked Unidentified", async () => {
    await renderRoster();
    const text = rowFor(ALIAS_NO_CONTACT).textContent ?? "";
    // Both halves in one row: the alias shows in its column, AND the marker.
    expect(aliasCell(ALIAS_NO_CONTACT)).toBe("Prairie Mill");
    expect(text).toContain(MARKER);
  });

  it("none announced + no contact → the marker renders beside the 'none announced' state", async () => {
    await renderRoster();
    expect(aliasCell(NONE)).toBe(NONE_ANNOUNCED);
    expect(rowFor(NONE).textContent).toContain(MARKER);
  });

  it("anti-vacuity: the NAMED row is not marked", async () => {
    await renderRoster();
    expect(rowFor(HAS_ALIAS).textContent).not.toContain(MARKER);
  });
});

describe("§11.8 a failed alias read degrades the column, not the roster", () => {
  it("FORBIDDING: read rejects → every roster row renders; the column shows the read-failed state, never 'not checked yet'", async () => {
    stub.getAdminPublicAliases.mockRejectedValue(Object.assign(new Error("unreachable"), { status: 500 }));
    await renderRoster();

    // Anti-vacuity: the roster itself is intact.
    expect(host.querySelectorAll("tbody tr")).toHaveLength(ALL.length);
    for (const k of ALL) expect(host.textContent).toContain(short(k));

    expect(aliasHeader().textContent).toContain(READ_FAILED_HEADER);
    for (const k of ALL) {
      expect(aliasCell(k), `a failed read asserts nothing per row (${short(k)})`).toBe(READ_FAILED_CELL);
    }
    expect(host.textContent).not.toContain(NOT_CHECKED);
    // D4's marker keys on contacts, not on this read — it still renders.
    expect(rowFor(NONE).textContent).toContain(MARKER);
  });

  it("PERMITTING HALF: a SUCCESSFUL empty read shows 'not checked yet' on every row, header normal", async () => {
    stub.getAdminPublicAliases.mockResolvedValue({ aliases: [] });
    await renderRoster();
    for (const k of ALL) expect(aliasCell(k)).toBe(NOT_CHECKED);
    expect(aliasHeader().textContent).not.toContain(READ_FAILED_HEADER);
  });
});

describe("§11.11 the refresh button — never silent", () => {
  it("success → the counts line renders, and the alias read is refetched", async () => {
    await renderRoster();
    const readsBefore = stub.getAdminPublicAliases.mock.calls.length;

    await act(async () => { button(REFRESH_BUTTON).click(); });
    await flush();

    expect(stub.refreshAdminPublicAliases).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(REFRESH_RESULT);
    expect(stub.getAdminPublicAliases.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("the button is disabled while a refresh runs", async () => {
    let release!: (v: unknown) => void;
    stub.refreshAdminPublicAliases.mockReturnValue(new Promise((r) => (release = r)));
    await renderRoster();

    // Found by "alias" rather than the exact label: the label may change while
    // running. Exactly one such button, so this cannot pick up "Refresh now".
    const aliasButton = () => {
      const found = Array.from(host.querySelectorAll("button")).filter((b) =>
        (b.textContent ?? "").toLowerCase().includes("alias"),
      );
      expect(found).toHaveLength(1);
      return found[0] as HTMLButtonElement;
    };

    await act(async () => { button(REFRESH_BUTTON).click(); });
    expect(aliasButton().disabled, "disabled while the refresh runs").toBe(true);
    expect(stub.refreshAdminPublicAliases).toHaveBeenCalledTimes(1);

    await act(async () => { release({ ok: true, total: 0, alias: 0, none_announced: 0, not_in_graph: 0, failed: 0 }); });
    await flush();
    expect(aliasButton().disabled).toBe(false);
  });

  it("409 → says a refresh is already running", async () => {
    stub.refreshAdminPublicAliases.mockRejectedValue(
      Object.assign(new Error("refresh_in_progress"), { status: 409, code: "refresh_in_progress" }),
    );
    await renderRoster();
    await act(async () => { button(REFRESH_BUTTON).click(); });
    await flush();
    expect(host.textContent).toContain(REFRESH_IN_PROGRESS);
    expect(host.textContent).not.toContain(REFRESH_FAILED);
  });

  it("any other failure → says the refresh failed, with the code", async () => {
    stub.refreshAdminPublicAliases.mockRejectedValue(
      Object.assign(new Error("public_alias_refresh_failed"), { status: 500, code: "public_alias_refresh_failed" }),
    );
    await renderRoster();
    await act(async () => { button(REFRESH_BUTTON).click(); });
    await flush();
    expect(host.textContent).toContain(REFRESH_FAILED);
    expect(host.textContent).toContain("public_alias_refresh_failed");
    // Anti-vacuity: the roster survives a failed refresh.
    expect(host.querySelectorAll("tbody tr")).toHaveLength(ALL.length);
  });
});

describe("search matches the public alias (spec §7, PROPOSED)", () => {
  it("typing part of an alias, in any case, filters to that row", async () => {
    await renderRoster();
    const input = host.querySelector("input.admin-members-search") as HTMLInputElement | null;
    expect(input, "the roster search box").not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "lazy h");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const rows = Array.from(host.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(short(HAS_ALIAS));
  });
});
