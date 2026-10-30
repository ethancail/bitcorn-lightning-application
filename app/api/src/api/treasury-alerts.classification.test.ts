// The treasury classification alert — every channel peer the server classifier
// calls `unclassified` (bitcorn-research
// specs/2026-10-30-subscription-guard-classification-alert-spec.md §5, with the
// rulings P-1 to P-5 of the same arc).
//
// WHY THIS IS NOT IN treasury-alerts.test.ts: that file mocks ../db for its
// whole module graph, and these cases are about what the producer does with
// real rows. Seam: lanePurpose.test.ts's — temp DB_DIR, the real migration
// chain, dynamic import once env is set. Only LND and Loop are doubles, because
// neither is what is under test and the other producers need an answer.
//
// ⚠ THE POSITIVE ARMS ARE LOAD-BEARING. DW2, DW3, DW6 and DW8 assert that the
// alert is ABSENT, which code with no producer at all satisfies. Each therefore
// first shows the alert firing on the same fixture without the thing that
// exempts it, so each one is red on pre-change code for the right reason, and
// an absence below means the exemption did it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-treasury-classification-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return { ...actual, getLndChainBalance: async () => ({ chain_balance: 1_000_000_000 }) };
});

vi.mock("../lightning/loop", () => ({
  isLoopAvailable: async () => ({ available: true, version: "test" }),
}));

const NEW_TYPE = "CHANNEL_PEERS_UNCLASSIFIED";
const HEADING = "Channel peers not tagged";
const message = (n: number) =>
  `${n} channel peer(s) aren't tagged. Tag each one in Contacts as merchant, farmer or external, ` +
  "so subscription billing and enforcement treat it correctly.";

// LND reports keys lowercase.
const PEER = "02" + "c7".repeat(32);
const OTHER_PEER = "03" + "d9".repeat(32);
// The curated key at lanePurpose.ts:30-32. Its exclusion needs no contact row.
const CURATED_EXTERNAL = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";

let db: BetterSqlite3.Database;
let getTreasuryAlerts: typeof import("./treasury-alerts").getTreasuryAlerts;
let nextChannelId = 1;

function seedChannel(pubkey: string, active: 0 | 1 = 1): void {
  db.prepare(
    `INSERT INTO lnd_channels (
       channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at, first_seen_at
     ) VALUES (?, ?, 1000000, 500000, 500000, ?, 0, ?, 0)`,
  ).run(String(nextChannelId++), pubkey, active, Date.now());
}

function seedContact(pubkey: string, tags: string | null, name = "Contact Name"): void {
  db.prepare(
    `INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'manual', 0, 0)`,
  ).run(pubkey, name, tags);
}

function seedSubscription(pubkey: string, tier: string): void {
  db.prepare(
    `INSERT INTO subscription (
       member_pubkey, deposit_address, derivation_path, paid_through, created_at, current_tier
     ) VALUES (?, ?, 'm/0/0', 0, 0, ?)`,
  ).run(pubkey, `addr-${pubkey}`, tier);
}

function seedPrivateName(pubkey: string, name: string): void {
  db.prepare(
    `INSERT INTO member_private_name (pubkey, name, signed_at, received_at) VALUES (?, ?, 0, 0)`,
  ).run(pubkey, name);
}

function seedPublicAlias(pubkey: string, outcome: "alias" | "none_announced", alias: string | null): void {
  db.prepare(
    `INSERT INTO peer_public_alias (pubkey, outcome, alias, outcome_at, last_attempt_at, last_attempt_ok)
     VALUES (?, ?, ?, 0, 0, 1)`,
  ).run(pubkey, outcome, alias);
}

async function newTypeAlerts() {
  return (await getTreasuryAlerts()).filter((a) => a.type === NEW_TYPE);
}

/** Exactly one alert of the new type, or a failure naming the arm that wanted it. */
async function theAlert(arm: string) {
  const alerts = await newTypeAlerts();
  expect(alerts.length, `${arm}: expected exactly one ${NEW_TYPE} alert`).toBe(1);
  return alerts[0];
}

beforeAll(async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ getTreasuryAlerts } = await import("./treasury-alerts"));
  log.mockRestore();
});

beforeEach(() => {
  db.exec(
    `DELETE FROM contacts; DELETE FROM lnd_channels; DELETE FROM subscription;
     DELETE FROM member_private_name; DELETE FROM peer_public_alias;`,
  );
});

afterAll(() => {
  db.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("the alert fires for every untagged channel peer", () => {
  it("DW1: a channel peer with no contact → one alert, count 1, warning, the ruled heading and message", async () => {
    seedChannel(PEER);

    const alert = await theAlert("DW1");
    expect(alert.severity).toBe("warning");
    expect(alert.data.count).toBe(1);
    expect(alert.heading).toBe(HEADING);
    expect(alert.message).toBe(message(1));
  });

  it("DW1: {n} counts peers, not channels, and data carries nothing but the count and the names", async () => {
    seedChannel(PEER);
    seedChannel(PEER);
    seedChannel(OTHER_PEER);

    const alert = await theAlert("DW1, count");
    expect(alert.data.count).toBe(2);
    expect(alert.message).toBe(message(2));
    expect(alert.data.names).toHaveLength(2);
    expect(Object.keys(alert.data).sort()).toEqual(["count", "names"]);
  });

  it("DW4: an active = 0 channel is still alerted", async () => {
    seedChannel(PEER, 0);

    expect((await theAlert("DW4")).data.count).toBe(1);
  });

  it("DW7: an untagged contact with no subscription row is alerted", async () => {
    seedChannel(PEER);
    seedContact(PEER, null);

    expect((await theAlert("DW7")).data.count).toBe(1);
  });
});

describe("the alert stays away from peers the classifier places", () => {
  it.each(["merchant", "farmer"])("DW2: tagging the DW1 peer %s clears the alert", async (tag) => {
    seedChannel(PEER);
    await theAlert("DW2 positive arm");

    seedContact(PEER, tag);

    expect(await newTypeAlerts()).toEqual([]);
  });

  it("DW3: a channel to the curated external key → no alert", async () => {
    seedChannel(PEER);
    await theAlert("DW3 positive arm");
    db.exec("DELETE FROM lnd_channels");

    seedChannel(CURATED_EXTERNAL);

    expect(await newTypeAlerts()).toEqual([]);
  });

  it("DW3: a contact tagged external → no alert", async () => {
    seedChannel(PEER);
    await theAlert("DW3 positive arm");

    seedContact(PEER, "external");

    expect(await newTypeAlerts()).toEqual([]);
  });

  it("DW6: a farmer tag padded with whitespace clears the alert — the server classifier trims", async () => {
    seedChannel(PEER);
    await theAlert("DW6 positive arm");

    seedContact(PEER, "  vip ,  farmer  ");

    expect(await newTypeAlerts()).toEqual([]);
  });

  it("DW8: no channels at all → no alert, and the list really was built", async () => {
    seedChannel(PEER);
    await theAlert("DW8 positive arm");
    db.exec("DELETE FROM lnd_channels");

    const alerts = await getTreasuryAlerts();

    expect(alerts.filter((a) => a.type === NEW_TYPE)).toEqual([]);
    // Anti-vacuity: a migrated DB has no valuation inputs, so this producer,
    // which runs after the new one, fires. An empty list would prove nothing.
    expect(alerts.map((a) => a.type)).toContain("VALUATION_MANUAL_STALE");
  });
});

describe("close_due escalates, and only on an alerted peer's own row", () => {
  it("DW5: an alerted peer whose row is close_due → critical", async () => {
    seedChannel(PEER);
    seedSubscription(PEER, "close_due");

    expect((await theAlert("DW5")).severity).toBe("critical");
  });

  it("DW5: a routing_lapsed row on the alerted peer stays warning, with close_due only on a tagged peer", async () => {
    seedChannel(PEER);
    seedSubscription(PEER, "routing_lapsed");
    seedChannel(OTHER_PEER);
    seedContact(OTHER_PEER, "merchant");
    seedSubscription(OTHER_PEER, "close_due");

    const alert = await theAlert("DW5, routing_lapsed arm");
    expect(alert.data.count).toBe(1);
    expect(alert.severity).toBe("warning");
  });

  it("DW5: a close_due row on a TAGGED peer does not escalate an alert about someone else", async () => {
    seedChannel(PEER);
    seedChannel(OTHER_PEER);
    seedContact(OTHER_PEER, "farmer");
    seedSubscription(OTHER_PEER, "close_due");

    const alert = await theAlert("DW5, tagged arm");
    expect(alert.data.count).toBe(1);
    expect(alert.severity).toBe("warning");
  });
});

describe("P-2: the name chain — contact, private name, public alias, key prefix", () => {
  const names = async (arm: string) => (await theAlert(arm)).data.names;
  const KEY_PREFIX = PEER.slice(0, 16);

  it("a contact's real name wins over both other sources", async () => {
    seedChannel(PEER);
    seedContact(PEER, null, "Grain Elevator");
    seedPrivateName(PEER, "Private Name");
    seedPublicAlias(PEER, "alias", "Public Alias");

    expect(await names("contact")).toEqual(["Grain Elevator"]);
  });

  it.each([
    ["the 8…6 placeholder sync-peers used to write", `${PEER.slice(0, 8)}…${PEER.slice(-6)}`],
    ["LND's 20-hex default alias", PEER.slice(0, 20)],
  ])("a contact named with %s is skipped for the next source", async (_label, placeholder) => {
    seedChannel(PEER);
    seedContact(PEER, null, placeholder);
    seedPrivateName(PEER, "Private Name");

    expect(await names("placeholder")).toEqual(["Private Name"]);
  });

  it("the private name wins over the public alias", async () => {
    seedChannel(PEER);
    seedPrivateName(PEER, "Private Name");
    seedPublicAlias(PEER, "alias", "Public Alias");

    expect(await names("private")).toEqual(["Private Name"]);
  });

  it("the public alias is used where outcome = 'alias'", async () => {
    seedChannel(PEER);
    seedPublicAlias(PEER, "alias", "Public Alias");

    expect(await names("public")).toEqual(["Public Alias"]);
  });

  it("no source at all → the first 16 hex characters of the key", async () => {
    seedChannel(PEER);

    expect(await names("fallback")).toEqual([KEY_PREFIX]);
    expect(KEY_PREFIX).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a placeholder contact and a none_announced row still fall through to the key prefix", async () => {
    seedChannel(PEER);
    seedContact(PEER, null, PEER.slice(0, 20));
    seedPublicAlias(PEER, "none_announced", null);

    expect(await names("fall through")).toEqual([KEY_PREFIX]);
  });
});
