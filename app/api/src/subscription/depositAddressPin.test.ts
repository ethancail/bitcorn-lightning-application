// The address pin and its host-only acknowledgement (bitcorn-research
// specs/2026-11-10-treasury-price-trust-spec.md §6; control C11). Real
// migrations against a temp database.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pin-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const MEMBER = "02" + "cc".repeat(32);
const A = "bcrt1qaddressaaaa";
const B = "bcrt1qaddressbbbb";

let db: import("better-sqlite3").Database;
let pin: typeof import("./depositAddressPin");
let ack: typeof import("./addressAcknowledge").acknowledgeDepositAddressChange;
let markers: typeof import("./sendMarker");

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  pin = await import("./depositAddressPin");
  ({ acknowledgeDepositAddressChange: ack } = await import("./addressAcknowledge"));
  markers = await import("./sendMarker");
});

beforeEach(() => {
  db.prepare("DELETE FROM subscription_deposit_address_pin").run();
  db.prepare("DELETE FROM subscription_send_marker").run();
});

const rows = () =>
  db.prepare("SELECT deposit_address, source FROM subscription_deposit_address_pin ORDER BY id").all();

describe("first sight (§6.2)", () => {
  it("no history: pins the stated address as first_sight, once", () => {
    expect(pin.ensurePin(db, MEMBER, A, 1).deposit_address).toBe(A);
    expect(pin.ensurePin(db, MEMBER, B, 2).deposit_address, "a second sight must not re-pin").toBe(A);
    expect(rows()).toEqual([{ deposit_address: A, source: "first_sight" }]);
  });

  it("a node that has paid before pins its last-paid address (marker_seed), even if the status states another", () => {
    markers.writeMarker(db, {
      member_pubkey: MEMBER, origin: "manual", amount_sats: 1, deposit_address: A,
      paid_through_at_write: 1, last_payment_txid_at_write: null, created_at: 1,
    });
    expect(pin.ensurePin(db, MEMBER, B, 1).deposit_address).toBe(A);
    expect(rows()).toEqual([{ deposit_address: A, source: "marker_seed" }]);
  });

  it("the current pin is the newest row", () => {
    pin.ensurePin(db, MEMBER, A, 1);
    pin.appendAcknowledgedPin(db, MEMBER, B, 2);
    expect(pin.getCurrentPin(db, MEMBER)?.deposit_address).toBe(B);
  });
});

function verified(address: string | null) {
  return async () =>
    ({
      ok: true,
      verdict: "verified",
      httpStatus: 200,
      bytes: Buffer.from(""),
      status: address == null ? { applicable: false, reason: "missing" } : { applicable: true, deposit_address: address },
    }) as any;
}

describe("C11 — the host acknowledgement (§6.4)", () => {
  it("refuses when its argument is not the verified stated address, and when unverified; appends nothing", async () => {
    pin.ensurePin(db, MEMBER, A, 1);

    const mismatch = await ack({ address: B, memberPubkey: MEMBER, fetchStatus: verified("bcrt1qsomethingelse"), db, nowSec: 2 });
    expect(mismatch, "C11: pinned an address the member did not name").toMatchObject({ ok: false, code: "address_mismatch" });

    const unsigned = await ack({
      address: B, memberPubkey: MEMBER, db, nowSec: 2,
      fetchStatus: async () => ({ ok: false, code: "status_unverified", verdict: "unsigned", detail: "", httpStatus: 200, bytes: Buffer.from("") }),
    });
    expect(unsigned).toMatchObject({ ok: false, code: "status_unverified" });

    const notApplicable = await ack({ address: B, memberPubkey: MEMBER, fetchStatus: verified(null), db, nowSec: 2 });
    expect(notApplicable).toMatchObject({ ok: false, code: "not_applicable" });

    expect(rows(), "a refusal appended a pin").toEqual([{ deposit_address: A, source: "first_sight" }]);

    // Anti-vacuity: the named address, verified as stated, is appended.
    const ok = await ack({ address: B, memberPubkey: MEMBER, fetchStatus: verified(B), db, nowSec: 3 });
    expect(ok).toEqual({ ok: true, action: "pinned", address: B, previous: A });
    expect(pin.getCurrentPin(db, MEMBER)).toMatchObject({ deposit_address: B, source: "acknowledged" });
    // Idempotent once pinned.
    expect(await ack({ address: B, memberPubkey: MEMBER, fetchStatus: verified(B), db, nowSec: 4 })).toMatchObject({
      ok: true, action: "already_pinned",
    });
  });

  it("no 3101 route can append an acknowledged pin: only the host command reaches it", () => {
    const src = path.resolve(__dirname, "..");
    const reachers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
          const text = fs.readFileSync(p, "utf8");
          if (/appendAcknowledgedPin|acknowledgeDepositAddressChange|addressAcknowledge|'acknowledged'\)/.test(text)) {
            reachers.push(path.relative(src, p));
          }
        }
      }
    };
    walk(src);
    // Anti-vacuity: the scan does find the definitions and the command.
    expect(reachers.sort()).toEqual([
      "cli/acknowledge-deposit-address.ts",
      "subscription/addressAcknowledge.ts",
      "subscription/depositAddressPin.ts",
    ]);
    // index.ts (every 3101 route) is not among them.
    expect(reachers).not.toContain("index.ts");
  });
});
