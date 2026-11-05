// drive-mode P2 item 9 (R6(c)): the plain-sentence pass on the cert banner.
//
// The member reads "your Lightning app's security certificate", not "LND's TLS
// certificate". The two-restart step is NOT reworded: it stays verbatim and
// whole in both levels, because its close condition — one watched cert
// rotation with loopd running — is still unmet
// (decisions/2026-08-26-cert-fault-remediation-loop-step-moves.md; the P2
// plan's constraint). certExpiry.test.ts keeps the property pins; this file
// pins the step's exact words.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { inspectCertBytes, certExpiryMessage } from "./certExpiry";

const CERT_A = fs.readFileSync(path.join(__dirname, "__fixtures__", "lnd-tls-a.crt"));
const NOT_AFTER = Date.UTC(2036, 7, 18, 23, 6, 27); // openssl notAfter of the fixture
const DAY = 86_400_000;

const msgAt = (now: number) => certExpiryMessage(inspectCertBytes(CERT_A, now), now) ?? "";

// The two-restart steps, as shipped before P2 — one per level.
const STEP_EXPIRED =
  "Restart the Lightning app to regenerate it, then restart Bitcorn. " +
  "The second restart is what gets Loop working again — it doesn't pick up the new certificate on its own.";
const STEP_EXPIRING =
  "The fix at that point: restart the Lightning app so LND issues a new certificate, then restart Bitcorn. " +
  "The second restart is what gets Loop working again — it doesn't pick up the new certificate on its own.";

describe("the two-restart step stays verbatim and whole", () => {
  it("expired", () => {
    expect(msgAt(NOT_AFTER + 2 * DAY)).toContain(STEP_EXPIRED);
  });

  it("expiring soon", () => {
    expect(msgAt(NOT_AFTER - 5 * DAY)).toContain(STEP_EXPIRING);
  });
});

describe("the rest reads in plain words", () => {
  it("expired: the member's own words for the certificate, the date, what stops", () => {
    expect(msgAt(NOT_AFTER + 2 * DAY)).toBe(
      "Your Lightning app's security certificate expired on 2036-08-18 (2 days ago). " +
      "Until a new one is issued, your channel figures won't update and payments sent from Bitcorn won't go through. " +
      STEP_EXPIRED,
    );
  });

  it("expiring soon: the same", () => {
    expect(msgAt(NOT_AFTER - 5 * DAY)).toBe(
      "Your Lightning app's security certificate expires on 2036-08-18 (5 days away). " +
      "Once it lapses, your channel figures will stop updating and payments sent from Bitcorn won't go through. " +
      STEP_EXPIRING,
    );
  });

  it("no \"TLS\" outside the verbatim step", () => {
    for (const [msg, step] of [[msgAt(NOT_AFTER + 2 * DAY), STEP_EXPIRED], [msgAt(NOT_AFTER - 5 * DAY), STEP_EXPIRING]]) {
      expect(msg.length).toBeGreaterThan(step.length);
      expect(msg.replace(step, "")).not.toMatch(/TLS|LND's/);
    }
  });
});
