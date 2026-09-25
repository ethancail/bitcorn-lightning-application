// The Contacts "Sync complete" line shows sync-peers' per-outcome counts.
//
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §9.4-9.5,
// §10, §11.11. Decision D7 §4.3 (Ethan's direct yes).
//
// WHY: sync-peers no longer inserts a contacts row for a peer with no real
// alias (§9.2). Without the counts, a sync that looked up five peers and added
// one would read as "1 added" — the four peers it deliberately left out would
// vanish without a trace. The counts are how the operator sees them.
//
// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §10). Hardcoded on purpose — a test
// importing the constant it asserts cannot detect a copy change.
//
// ⚠ PRE-CHANGE RUN: red against 30de308, which rendered
// "Sync complete: N added, M skipped." with no per-outcome counts.
//
// OUT OF SCOPE, and left alone: the `.catch(() => setSyncResult(null))` that
// makes a FAILED sync silent (a BACKLOG §2 finding, spec §9.5).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const SYNC_LINE =
  "Sync complete: 2 added, 3 already in contacts. Not added: 4 announced no alias, 5 not in the public graph, 6 lookups failed."; // §10 — PROPOSED

const stub = vi.hoisted(() => ({
  getContacts: vi.fn(),
  getNode: vi.fn(),
  syncPeers: vi.fn(),
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
  stub.syncPeers.mockResolvedValue({
    ok: true,
    added: 2,
    skipped: 3,
    none_announced: 4,
    not_in_graph: 5,
    failed: 6,
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

describe("Contacts sync result — spec §9.5", () => {
  it("the Sync complete line renders all five counts, each in its own place", async () => {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(Contacts)));
    });
    await flush();

    const syncButton = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Import from my channels"),
    );
    expect(syncButton, "the sync button").toBeDefined();
    // Anti-vacuity: nothing claims a sync before one ran.
    expect(host.textContent).not.toContain("Sync complete");

    await act(async () => { syncButton!.click(); });
    await flush();

    expect(stub.syncPeers).toHaveBeenCalledTimes(1);
    // Distinct numbers per field, so a swapped or dropped count fails here
    // rather than coincidentally matching.
    expect(host.textContent).toContain(SYNC_LINE);
  });
});
