// buildLiquidityPeers against case-mixed contacts — billing-pubkey-case arc
// (bitcorn-research specs/2026-10-28-billing-pubkey-case-normalization-spec.md,
// D1: DW-5 and DW-13 for the liquidity view).
//
// The channel's peer key arrives in LND's lowercase; the contact may be stored
// in any case. The role must come from the contact's tags — and, among case
// twins, from the backend's tie-break winner (manual, then lowest id) — or the
// view shows a correctly classified member as `unknown` and unnamed.

import { describe, expect, it } from "vitest";
import { buildLiquidityPeers, type ChannelData } from "./transform";
import { truncPubkey, type Contact } from "../../api/client";

const LOWER = "03" + "d4".repeat(32);
const UPPER = LOWER.toUpperCase();
const ABSENT = "02" + "e5".repeat(32);

const contact = (id: number, pubkey: string, name: string, source: Contact["source"], tags: string[]): Contact => ({
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

const channel = (peer: string, id: string): ChannelData => ({
  channel_id: id,
  peer_pubkey: peer,
  capacity_sat: 1_000_000,
  local_balance_sat: 500_000,
  remote_balance_sat: 500_000,
  active: 1,
});

const peerFor = (pubkey: string, channels: ChannelData[], contacts: Contact[]) =>
  buildLiquidityPeers(channels, contacts).find((p) => p.pubkey === pubkey);

describe("DW-5: the liquidity view classifies and names an uppercase-stored contact", () => {
  it("role from the tags (merchant) and the contact's name, for LND's lowercase key", () => {
    const p = peerFor(LOWER, [channel(LOWER, "1")], [contact(1, UPPER, "Prairie Mill", "manual", ["merchant"])]);
    expect(p).toMatchObject({ role: "merchant", name: "Prairie Mill" });
  });

  it("ANTI-VACUITY: a peer with no contact is `unknown` and shows the truncated key", () => {
    const p = peerFor(ABSENT, [channel(ABSENT, "2")], [contact(1, UPPER, "Prairie Mill", "manual", ["merchant"])]);
    expect(p).toMatchObject({ role: "unknown", name: truncPubkey(ABSENT) });
  });
});

describe("DW-13: the liquidity view takes the tie-break winner of a case-duplicate pair", () => {
  // GET /api/contacts orders by name, so the losing row ("Alpha Auto") comes first.
  const losing = contact(1, LOWER, "Alpha Auto", "auto", ["farmer"]);
  const manual = contact(2, UPPER, "Zulu Manual", "manual", ["merchant"]);

  it.each([
    ["losing row first", [losing, manual]],
    ["manual row first", [manual, losing]],
  ])("the MANUAL row's role and name (%s)", (_l, contacts) => {
    expect(peerFor(LOWER, [channel(LOWER, "1")], contacts)).toMatchObject({ role: "merchant", name: "Zulu Manual" });
  });

  it("two auto rows → the LOWER id's role and name, whatever the data order", () => {
    const first = contact(1, UPPER, "Zulu First", "auto", ["merchant"]);
    const second = contact(2, LOWER, "Alpha Second", "auto", ["farmer"]);
    for (const contacts of [[second, first], [first, second]]) {
      expect(peerFor(LOWER, [channel(LOWER, "1")], contacts)).toMatchObject({ role: "merchant", name: "Zulu First" });
    }
  });
});
