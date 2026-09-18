// Roster-union coverage for the admin Members list.
//
// WHY THIS FILE EXISTS: computeMembersListForTreasury had ZERO test
// coverage before this. The roster-union change alters BOTH which rows
// exist (channel peers ∪ subscription rows) and the case those rows
// carry (canonical lowercase). Both failure modes are silent: a missed
// subscription row simply does not render, and a case mismatch
// mis-classifies a lane with no error and no crash. Neither would fail
// any pre-existing test, because there were none.
//
// Test seam (no production-code change): adminMembersHandler,
// statusHandler and lanePurpose all statically import `../db`, which
// opens SQLite and mkdirs DB_DIR at module load (default /data/db, not
// writable here). Same discipline as detector.test.ts and
// tierScope.test.ts — point DB_DIR at a throwaway temp dir, run the
// real migration chain, then pull the modules in via dynamic import
// once env is set.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-admin-members-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

let db: BetterSqlite3.Database;
let computeMembersListForTreasury:
  typeof import("./adminMembersHandler").computeMembersListForTreasury;
let classifyLanePurpose: typeof import("./lanePurpose").classifyLanePurpose;

// 66-char lowercase hex pubkeys, distinct in their repeated byte so a
// failure message names which fixture is involved.
const CHANNELLED = "02" + "c1".repeat(32);
const CHANNELLESS = "03" + "c2".repeat(32);
const BOTH = "02" + "b0".repeat(32);

const NOW = 1_784_900_000_000;
const MS_PER_DAY = 86_400_000;

function seedChannel(peerPubkey: string, channelId: string): void {
  db.prepare(
    `INSERT INTO lnd_channels (
       channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at, first_seen_at
     ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(channelId, peerPubkey, 1_000_000, 500_000, 500_000, NOW, NOW - 90 * MS_PER_DAY);
}

function seedSubscription(memberPubkey: string, tier = "current"): void {
  db.prepare(
    `INSERT INTO subscription (
       member_pubkey, deposit_address, derivation_path, paid_through,
       created_at, current_tier
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    memberPubkey,
    `bcrt1q${memberPubkey.slice(2, 20)}`,
    `bitcorn:subscription:${memberPubkey.slice(0, 16)}`,
    NOW + 15 * MS_PER_DAY,
    NOW - 30 * MS_PER_DAY,
    tier,
  );
}

let txCounter = 0;
function seedPayment(memberPubkey: string, amountSats: number): void {
  db.prepare(
    `INSERT INTO subscription_payment (
       member_pubkey, txid, vout, amount_sats, amount_usd_cents_at_receipt,
       received_at, confirmed_at, period_extension_days, kind, admin_reason
     ) VALUES (?, ?, 0, ?, NULL, ?, ?, 30, 'onchain', NULL)`,
  ).run(memberPubkey, `tx${txCounter++}`, amountSats, NOW, NOW);
}

function seedContact(pubkey: string, tags: string): void {
  db.prepare(
    `INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'manual', ?, ?)`,
  ).run(pubkey, `name-${pubkey.slice(0, 8)}`, tags, NOW, NOW);
}

function rowFor(members: Array<{ member_pubkey: string }>, pubkey: string) {
  return members.find((m) => m.member_pubkey === pubkey);
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ computeMembersListForTreasury } = await import("./adminMembersHandler"));
  ({ classifyLanePurpose } = await import("./lanePurpose"));
});

beforeEach(() => {
  db.prepare("DELETE FROM subscription_payment").run();
  db.prepare("DELETE FROM subscription").run();
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare("DELETE FROM contacts").run();
  txCounter = 0;
});

// ─── The permitting controls ──────────────────────────────────────
//
// These are the tests that matter. A test that merely forbids the old
// behaviour ("no row is missing") passes on a handler that returns
// nothing at all. Each of these asserts that a row IS PRESENT and
// carries the RIGHT CONTENT.

describe("roster union — a subscription row is a member, channel or not", () => {
  it("a subscription row with NO channel produces a roster row, with its tier", () => {
    seedSubscription(CHANNELLESS, "current");
    seedContact(CHANNELLESS, "merchant");

    const result = computeMembersListForTreasury();
    const row = rowFor(result.members, CHANNELLESS);

    // Presence — the property the change exists to deliver.
    expect(
      row,
      `channel-less subscription row ${CHANNELLESS} is absent from the roster; ` +
        `roster contained: ${JSON.stringify(result.members.map((m) => m.member_pubkey))}`,
    ).toBeDefined();

    // Right content, asserted in the same test (anti-vacuity): the row
    // carries its enrolled tier, its lane, and the canonical pubkey.
    expect(row!.member_pubkey).toBe(CHANNELLESS);
    expect(row!.subscription_state).toBe("current");
    expect(row!.current_tier).toBe("current");
    expect(row!.lane_purpose).toBe("merchant_lane");
    expect(row!.paid_through).toBe(NOW + 15 * MS_PER_DAY);
  });

  it("a channelled peer still appears, unchanged, with its payment amount", () => {
    seedChannel(CHANNELLED, "111:1:0");
    seedSubscription(CHANNELLED, "worker_lapsed");
    seedPayment(CHANNELLED, 50_000);
    seedContact(CHANNELLED, "farmer");

    const result = computeMembersListForTreasury();
    const row = rowFor(result.members, CHANNELLED);

    expect(row, `channelled peer ${CHANNELLED} regressed out of the roster`).toBeDefined();
    expect(row!.subscription_state).toBe("worker_lapsed");
    expect(row!.current_tier).toBe("worker_lapsed");
    expect(row!.lane_purpose).toBe("farmer_lane");
    expect(row!.last_payment_amount_sats).toBe(50_000);
  });

  it("a channelled peer with NO subscription row still discriminates via Cases B-E", () => {
    // Pre-existing behaviour that the union must not disturb: a channel
    // peer with no contacts row and no subscription row is `unclassified`.
    seedChannel(CHANNELLED, "111:1:0");

    const result = computeMembersListForTreasury();
    const row = rowFor(result.members, CHANNELLED);

    expect(row).toBeDefined();
    expect(row!.subscription_state).toBe("unclassified");
    expect(row!.current_tier).toBeNull();
    expect(row!.lane_purpose).toBe("unclassified");
  });

  it("a peer with BOTH a channel and a subscription row appears exactly ONCE", () => {
    // UNION (not UNION ALL) dedupes. Without it the member would render
    // twice and be double-counted in totals.
    seedChannel(BOTH, "222:1:0");
    seedSubscription(BOTH, "current");
    seedContact(BOTH, "merchant");

    const result = computeMembersListForTreasury();
    const matching = result.members.filter((m) => m.member_pubkey === BOTH);

    expect(matching).toHaveLength(1);
    expect(matching[0].subscription_state).toBe("current");
  });
});

// ─── The case-normalization control (the binding constraint) ──────
//
// Lane classification GATES subscription scope. classifyLanePurpose does
// NOT lowercase (lanePurpose.ts:40,42) and contacts.pubkey is binary-
// collated, so the case the roster passes down decides the lane. The
// roster must agree with every other subscription-scope consumer, all of
// which classify on the LOWERCASE pubkey (statusHandler.ts:97,144).

describe("case normalization — the roster agrees with the subscription-scope path", () => {
  it("a MIXED-case channel row classifies on its lowercase form, like the scope path", () => {
    const mixed = "02" + "C1".repeat(32); // same pubkey as CHANNELLED, upper-cased
    expect(mixed.toLowerCase()).toBe(CHANNELLED); // fixture sanity

    seedChannel(mixed, "333:1:0");
    seedContact(CHANNELLED, "merchant"); // contacts holds the canonical lowercase form

    const result = computeMembersListForTreasury();

    // The roster emits the canonical pubkey, not the stored spelling.
    const row = rowFor(result.members, CHANNELLED);
    expect(
      row,
      `roster emitted a non-canonical pubkey; got ` +
        `${JSON.stringify(result.members.map((m) => m.member_pubkey))}`,
    ).toBeDefined();

    // Right content: merchant_lane, which is ONLY reachable if the
    // contacts lookup ran on the lowercase form.
    expect(row!.lane_purpose).toBe("merchant_lane");

    // And it agrees with what every scope consumer computes for this peer.
    expect(row!.lane_purpose).toBe(classifyLanePurpose(CHANNELLED));
  });

  it("a MIXED-case contacts row and a lowercase subscription row classify identically", () => {
    // The brief's named control. NOTE the honest expectation: because
    // classifyLanePurpose does not lowercase its contacts lookup
    // (lanePurpose.ts:42) and contacts.pubkey is binary-collated, a
    // mixed-case contacts row is unmatchable by ANY lowercase caller.
    // That is a PRE-EXISTING lanePurpose defect, out of scope here. What
    // IS in scope, and what this pins, is that the roster and the
    // subscription-scope path reach the SAME answer — no divergence.
    const mixedContact = "03" + "C2".repeat(32);
    expect(mixedContact.toLowerCase()).toBe(CHANNELLESS); // fixture sanity

    seedContact(mixedContact, "merchant");
    seedSubscription(CHANNELLESS, "current");

    const result = computeMembersListForTreasury();
    const row = rowFor(result.members, CHANNELLESS);

    expect(row).toBeDefined();
    expect(row!.member_pubkey).toBe(CHANNELLESS);
    // Identical to the scope path — the in-scope guarantee.
    expect(row!.lane_purpose).toBe(classifyLanePurpose(CHANNELLESS));
    // ...and that shared answer is `unclassified`, stated explicitly so
    // that fixing lanePurpose later breaks this line loudly rather than
    // silently changing what the roster shows.
    expect(row!.lane_purpose).toBe("unclassified");
  });
});

// ─── Totals change meaning: roster-wide, not channel-wide ─────────

describe("totals — roster-wide, which is a deliberate meaning change", () => {
  it("total_members counts subscription-only rows alongside channel peers", () => {
    seedChannel(CHANNELLED, "111:1:0");
    seedSubscription(CHANNELLESS, "current");
    seedChannel(BOTH, "222:1:0");
    seedSubscription(BOTH, "prepay");

    const result = computeMembersListForTreasury();

    // 3 distinct pubkeys: one channel-only, one subscription-only, one both.
    expect(result.totals.total_members).toBe(3);
    expect(result.members).toHaveLength(3);
    expect(new Set(result.members.map((m) => m.member_pubkey))).toEqual(
      new Set([CHANNELLED, CHANNELLESS, BOTH]),
    );
  });

  it("by_state counts the subscription-only row in its tier bucket", () => {
    seedSubscription(CHANNELLESS, "close_due");
    seedChannel(CHANNELLED, "111:1:0");

    const result = computeMembersListForTreasury();

    expect(result.totals.by_state.close_due).toBe(1);
    expect(result.totals.by_state.unclassified).toBe(1); // the bare channel peer
    // Full taxonomy still present and summing to the roster size.
    const summed = Object.values(result.totals.by_state).reduce((a, b) => a + b, 0);
    expect(summed).toBe(result.totals.total_members);
  });
});
