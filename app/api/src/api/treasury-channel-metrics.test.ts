// Per-channel forwarded fees and volume: each forward is split 50/50 between
// its incoming and its outgoing channel, so the totals across channels equal
// SUM(fee) and SUM(tokens) — decision A, bitcorn-research
// decisions/2026-10-22-forwarding-fee-attribution-split-50-50.md.
//
// The merge used to credit a forward's WHOLE fee and tokens to both legs, so
// every sat was counted twice and rotation, expansion and peer scoring read
// doubled activity as revenue. Rounding, per forward: the incoming channel
// gets floor(x/2), the outgoing channel the remainder.
//
// Harness: a temp DB_DIR + runMigrations(), no mocks. Forwards are seeded an
// hour old so both the all-time and the 24h aggregates see them.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-channel-metrics-db-"));
process.env.DB_DIR = TMP_DB;
process.env.TREASURY_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { getChannelMetrics } = await import("./treasury-channel-metrics");
const { getRotationCandidates } = await import("./treasury-rotation");

const pk = (c: string) => "02" + c.repeat(64);
const A = "100x1x0", B = "200x1x0", C = "300x1x0", D = "400x1x0";

function channel(id: string, peer: string, local: number) {
  db.prepare(
    `INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?)`
  ).run(id, peer, 2_000_000, local, 2_000_000 - local, Date.now());
}

let seq = 0;
function forward(incoming: string, outgoing: string, fee: number, tokens: number) {
  // created_at is milliseconds (lightning/persist-forwarded.ts); distinct per row
  // because (incoming, outgoing, created_at) is UNIQUE.
  db.prepare(
    "INSERT INTO payments_forwarded (incoming_channel, outgoing_channel, tokens, fee, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(incoming, outgoing, tokens, fee, Date.now() - 3_600_000 + seq++);
}

const byId = () => new Map(getChannelMetrics().map((m) => [m.channel_id, m]));

beforeEach(() => {
  db.prepare("DELETE FROM payments_forwarded").run();
  db.prepare("DELETE FROM lnd_channels").run();
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

describe("getChannelMetrics: a forward's fee and tokens are split 50/50 between its two legs", () => {
  beforeEach(() => {
    channel(A, pk("a"), 540_000);
    channel(B, pk("b"), 1_000_000);
    channel(C, pk("c"), 1_000_000);
    forward(A, B, 100, 10_000);
    forward(B, A, 7, 700);
  });

  it("FORBIDDING: totals across channels equal SUM(fee) and SUM(tokens), not twice them", () => {
    const metrics = getChannelMetrics();
    const fees = metrics.reduce((s, m) => s + m.forwarded_fees_sats, 0);
    const volume = metrics.reduce((s, m) => s + m.forwarded_volume_sats, 0);
    expect.soft(fees, "sum of forwarded_fees_sats").toBe(107);
    expect.soft(volume, "sum of forwarded_volume_sats").toBe(10_700);
  });

  it("PERMITTING: A and B carry their exact split (incoming floor, outgoing remainder); C stays 0", () => {
    const m = byId();
    // A: incoming of A→B (100/2 = 50, 10,000/2 = 5,000) + outgoing of B→A (7 − 3 = 4, 700 − 350 = 350).
    expect.soft(m.get(A)!.forwarded_fees_sats, "A fees").toBe(54);
    expect.soft(m.get(A)!.forwarded_volume_sats, "A volume").toBe(5_350);
    // B: outgoing of A→B (100 − 50 = 50, 5,000) + incoming of B→A (floor(7/2) = 3, 350).
    expect.soft(m.get(B)!.forwarded_fees_sats, "B fees").toBe(53);
    expect.soft(m.get(B)!.forwarded_volume_sats, "B volume").toBe(5_350);
    expect.soft(m.get(C)!.forwarded_fees_sats, "C fees").toBe(0);
    expect.soft(m.get(C)!.forwarded_volume_sats, "C volume").toBe(0);
  });

  it("the 24h path splits too: A's payback is local / its 24h half-share (540,000 / 54)", () => {
    expect(byId().get(A)!.payback_days).toBe(10_000);
  });
});

describe("a one-direction lane keeps nonzero forwarding under the split", () => {
  it("D only ever appears as an incoming leg: half its forwards' fee and volume, and rotation does not call it idle", () => {
    channel(A, pk("a"), 540_000);
    channel(C, pk("c"), 1_000_000); // never forwards: the control that "no forwarding volume" still fires
    channel(D, pk("d"), 1_000_000);
    forward(D, A, 9, 900);

    const m = byId();
    expect(m.get(D)!.forwarded_fees_sats, "D fees: floor(9/2)").toBe(4);
    expect(m.get(D)!.forwarded_volume_sats, "D volume: floor(900/2)").toBe(450);

    const candidates = new Map(getRotationCandidates().map((c) => [c.channel_id, c]));
    // D is a candidate (payback 1,000,000 / 4 = 250,000d > 730d), so its reason is read, not vacuously absent.
    const d = candidates.get(D);
    expect(d, "D is scored by rotation").toBeDefined();
    expect(d!.forwarded_volume_sats).toBe(450);
    expect(d!.reason).not.toContain("no forwarding volume");
    expect(candidates.get(C)?.reason, "C, with no forwards, is still called idle").toContain("no forwarding volume");
  });
});
