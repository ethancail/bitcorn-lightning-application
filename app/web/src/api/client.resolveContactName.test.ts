// resolveContactName against case-mixed contacts — billing-pubkey-case arc
// (bitcorn-research specs/2026-10-28-billing-pubkey-case-normalization-spec.md,
// D3: DW-5 and DW-13's name half).
//
// LND reports peer keys lowercase; contacts are stored as entered. The match
// is case-insensitive, and among case twins it takes the backend's tie-break
// winner — the manual row, then the lowest id — so the name shown is the row
// the API classifies by, not whichever twin sorts first by name.

import { describe, expect, it } from "vitest";
import { resolveContactName, truncPubkey, type Contact } from "./client";

const LOWER = "03" + "d4".repeat(32);
const UPPER = LOWER.toUpperCase();
const ABSENT = "02" + "e5".repeat(32);

const contact = (id: number, pubkey: string, name: string, source: Contact["source"], tags: string[] = []): Contact => ({
  id,
  pubkey,
  name,
  notes: null,
  tags,
  source,
  created_at: 0,
  updated_at: 0,
  channels: [],
});

describe("DW-5: an uppercase-stored contact resolves by LND's lowercase key", () => {
  it("shows the contact's name, not a truncated key", () => {
    expect(resolveContactName(LOWER, [contact(1, UPPER, "Prairie Mill", "manual", ["merchant"])])).toBe("Prairie Mill");
  });

  it("ANTI-VACUITY: a key with no contact still shows the truncated key", () => {
    expect(resolveContactName(ABSENT, [contact(1, UPPER, "Prairie Mill", "manual")])).toBe(truncPubkey(ABSENT));
  });
});

describe("DW-13: a case-duplicate pair resolves to the tie-break winner", () => {
  // GET /api/contacts orders by name, so "Alpha Auto" (the losing row) comes first.
  const losing = contact(1, LOWER, "Alpha Auto", "auto", ["farmer"]);
  const manual = contact(2, UPPER, "Zulu Manual", "manual", ["merchant"]);

  it.each([
    ["losing row first", [losing, manual]],
    ["manual row first", [manual, losing]],
  ])("the MANUAL row's name (%s)", (_l, contacts) => {
    expect(resolveContactName(LOWER, contacts)).toBe("Zulu Manual");
  });

  it("two auto rows → the LOWER id's name, whatever the data order", () => {
    const first = contact(1, UPPER, "Zulu First", "auto");
    const second = contact(2, LOWER, "Alpha Second", "auto");
    expect(resolveContactName(LOWER, [second, first])).toBe("Zulu First");
    expect(resolveContactName(LOWER, [first, second])).toBe("Zulu First");
  });
});
