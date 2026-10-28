// Lane classification and contact-name lookup against case-mixed `contacts`
// rows — billing-pubkey-case arc (bitcorn-research
// specs/2026-10-28-billing-pubkey-case-normalization-spec.md, DW-2, DW-3,
// DW-14).
//
// THE DEFECT: contacts.pubkey is BINARY-collated and stored as entered, while
// every caller of classifyLanePurpose passes LND's lowercase key. A member
// entered in uppercase was unreachable — classified `unclassified`, so out of
// subscription scope — and a case twin decided the lane by whichever spelling
// happened to equal the caller's.
//
// THE TIE-BREAK (ruling 1): among rows that match case-insensitively, the
// `manual` row wins, then the lowest id. The fixtures store the manual row in
// UPPERCASE and the auto row in lowercase, so an exact compare on the
// lowercase key finds the auto row — the arrangement that cannot pass by
// accident (spec §5.1 control 1).
//
// Seam: adminMembersHandler.test.ts's — temp DB_DIR, the real migration chain,
// dynamic import once env is set. DW-14 drives network-payments.ts's real
// payNetworkInvoice to its capacity pre-flight, whose error message carries
// resolveContact's answer; only the invoice decode and the LND handle are
// doubles.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-lane-purpose-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

const decode = vi.hoisted(() => ({ destination: "" }));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const decodePaymentRequest = async () => ({
    id: "ab".repeat(32),
    destination: decode.destination,
    tokens: 1_000,
    description: "probe",
  });
  return {
    ...actual,
    default: { ...(actual.default ?? actual), decodePaymentRequest },
    decodePaymentRequest,
  };
});

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return { ...actual, getLndClient: () => ({ lnd: {} }) as any };
});

let db: BetterSqlite3.Database;
let classifyLanePurpose: typeof import("./lanePurpose").classifyLanePurpose;
let payNetworkInvoice: typeof import("../lightning/network-payments").payNetworkInvoice;

// The same key in two spellings. LND reports LOWER.
const LOWER = "03" + "d4".repeat(32);
const UPPER = LOWER.toUpperCase();
const MIXED = "03" + "D4d4".repeat(16);
// A key with no contacts row at all — the anti-vacuity control.
const ABSENT = "02" + "e5".repeat(32);

function seedContact(pubkey: string, source: "manual" | "auto", tags: string | null, name = `name-${source}`): number {
  const r = db
    .prepare(
      `INSERT INTO contacts (pubkey, name, notes, tags, source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 0, 0)`,
    )
    .run(pubkey, name, tags, source);
  return Number(r.lastInsertRowid);
}

const storedPubkeys = () =>
  (db.prepare("SELECT pubkey FROM contacts ORDER BY id").all() as Array<{ pubkey: string }>).map((r) => r.pubkey);

/** The name payNetworkInvoice's capacity pre-flight puts in its error — resolveContact's answer. */
async function contactNameInPaymentError(destination: string): Promise<string> {
  decode.destination = destination;
  db.prepare(
    `INSERT INTO lnd_channels (
       channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at, first_seen_at
     ) VALUES ('900', ?, 1000000, 0, 1000000, 1, 0, 0, 0)`,
  ).run(destination);
  const err = await payNetworkInvoice("lnbcrt-probe").then(
    () => { throw new Error("expected the capacity pre-flight to refuse"); },
    (e: Error) => e,
  );
  const m = /^Insufficient channel capacity to (.*)\. You need/.exec(err.message);
  expect(m, `unexpected pre-flight error: ${err.message}`).not.toBeNull();
  return m![1];
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  ({ classifyLanePurpose } = await import("./lanePurpose"));
  ({ payNetworkInvoice } = await import("../lightning/network-payments"));
});

beforeEach(() => {
  db.exec("DELETE FROM contacts; DELETE FROM lnd_channels;");
});

describe("DW-2: a pre-existing uppercase contacts row classifies by its tags", () => {
  it("an uppercase farmer row, inserted directly, classifies farmer_lane on LND's lowercase key — and stays uppercase on disk", () => {
    seedContact(UPPER, "manual", "farmer");

    expect(classifyLanePurpose(LOWER), "the uppercase row must be found by the lowercase key").toBe("farmer_lane");
    // No rewrite: the fix compares case-insensitively; it does not migrate data.
    expect(storedPubkeys()).toEqual([UPPER]);
  });

  it("ANTI-VACUITY: a key with no contacts row still classifies unclassified", () => {
    seedContact(UPPER, "manual", "farmer");
    expect(classifyLanePurpose(ABSENT)).toBe("unclassified");
  });
});

describe("DW-3: a case-duplicate pair classifies by the tie-break winner", () => {
  it.each([
    ["manual inserted first", ["manual", "auto"] as const],
    ["auto inserted first", ["auto", "manual"] as const],
  ])("manual UPPERCASE + auto lowercase, different tags (%s) → the MANUAL row's lane", (_label, order) => {
    for (const source of order) {
      if (source === "manual") seedContact(UPPER, "manual", "merchant");
      else seedContact(LOWER, "auto", "farmer");
    }

    expect(classifyLanePurpose(LOWER), "the manual row's tags (merchant) must decide, in either insertion order").toBe(
      "merchant_lane",
    );
  });

  it("two auto rows, different tags → the LOWER id's lane", () => {
    seedContact(UPPER, "auto", "merchant"); // lower id
    seedContact(LOWER, "auto", "farmer");

    expect(classifyLanePurpose(LOWER), "between two auto rows the lower id must decide").toBe("merchant_lane");
  });
});

describe("DW-14: resolveContact and classifyLanePurpose give one answer for a duplicate pair", () => {
  it.each([
    ["manual inserted first", ["manual", "auto"] as const],
    ["auto inserted first", ["auto", "manual"] as const],
  ])("the payment error names the MANUAL row, and the lane is the MANUAL row's (%s)", async (_label, order) => {
    for (const source of order) {
      if (source === "manual") seedContact(UPPER, "manual", "merchant", "Manual Mill");
      else seedContact(MIXED, "auto", "farmer", "Auto Alias");
    }
    // A third spelling, lowercase, so neither stored row equals the caller's key.
    expect(await contactNameInPaymentError(LOWER)).toBe("Manual Mill");
    expect(classifyLanePurpose(LOWER)).toBe("merchant_lane");
  });

  it("the same pair with the auto row stored lowercase — resolveContact still names the MANUAL row", async () => {
    seedContact(LOWER, "auto", "farmer", "Auto Alias");
    seedContact(UPPER, "manual", "merchant", "Manual Mill");

    expect(await contactNameInPaymentError(LOWER)).toBe("Manual Mill");
    expect(classifyLanePurpose(LOWER)).toBe("merchant_lane");
  });

  it("ANTI-VACUITY: a destination with no contact falls back to the truncated key", async () => {
    seedContact(UPPER, "manual", "merchant", "Manual Mill");
    expect(await contactNameInPaymentError(ABSENT)).toBe(`${ABSENT.slice(0, 12)}…`);
  });
});
