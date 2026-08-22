// PAIR 2 — cert parsing and expiry classification.
//
// ─── ONE FIXTURE, A MOVING CLOCK ────────────────────────────────────────────
//
// There is no "expired cert" fixture and there does not need to be one. The
// inspector takes nowMs from the caller, so both directions are reached by
// moving the injected clock across the SAME certificate's notAfter. Two
// consequences worth stating: the committed fixtures never rot (no test reads
// Date.now(), so a fixture passing its own expiry in 2036 changes nothing), and
// the expired path is exercised without shipping a deliberately-broken artifact.
//
// The fixtures are self-signed CERTIFICATES ONLY — the generated private keys
// were discarded, not committed. Parsing needs no key.
//
// ⚠ AND THAT IS WHY THEY ARE `.crt`, NOT `.pem`. .gitignore:47 ignores `*.pem`
// under its `# Secrets` heading, so PEM-named fixtures are silently untracked:
// the suite passes locally off working-tree files and fails in CI on a missing
// path. The fix is the extension, NOT a negative exception in .gitignore — a
// carve-out there would punch a hole in a secrets rule to accommodate a test
// fixture. `.crt` is a standard name for a PEM-encoded certificate and is not
// ignored, so `*.pem` and `*.key` keep protecting real material. Verified both
// directions by exit code: these files are trackable, while a decoy
// `DECOY-private.pem`/`.key` in this same directory stayed ignored.
//
// ─── THE EXTERNAL ANCHOR ────────────────────────────────────────────────────
//
// FIXTURE_A_NOT_AFTER_MS is not copied out of this module's own output. It is
// the value `openssl x509 -noout -enddate` reports for the fixture
// (notAfter=Aug 18 23:06:27 2036 GMT), converted independently. So the parse is
// pinned against a different tool rather than against itself.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  inspectCertBytes,
  certExpiryLevel,
  certExpiryMessage,
  CERT_EXPIRY_WARN_DAYS,
} from "./certExpiry";

const FIXTURES = path.join(__dirname, "__fixtures__");
const CERT_A = fs.readFileSync(path.join(FIXTURES, "lnd-tls-a.crt"));

/** openssl: notAfter=Aug 18 23:06:27 2036 GMT  →  2036-08-18T23:06:27Z */
const FIXTURE_A_NOT_AFTER_MS = Date.UTC(2036, 7, 18, 23, 6, 27);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("inspectCertBytes — the facts", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // PAIR 2(a) — a known notAfter yields the right days-remaining.
  // ───────────────────────────────────────────────────────────────────────────
  it("reads notAfter and computes days-remaining against the injected clock", () => {
    const now = FIXTURE_A_NOT_AFTER_MS - 10 * MS_PER_DAY;
    const got = inspectCertBytes(CERT_A, now);

    expect(got.ok).toBe(true);
    if (!got.ok) return; // narrowing; the assertion above is the real gate

    // Pinned against openssl's answer, not against our own.
    expect(got.notAfterMs).toBe(FIXTURE_A_NOT_AFTER_MS);
    expect(got.daysRemaining).toBe(10);
    expect(got.isExpired).toBe(false);
    expect(got.subject).toContain("lnd-fixture-a");
  });

  it("floors days-remaining rather than rounding, so runway is never overstated", () => {
    // 9 days and 23 hours out must read 9, not 10.
    const now = FIXTURE_A_NOT_AFTER_MS - (10 * MS_PER_DAY - 60 * 60 * 1000);
    const got = inspectCertBytes(CERT_A, now);
    expect(got.ok && got.daysRemaining).toBe(9);
  });

  it("reports expiry with a negative days-remaining once the clock passes notAfter", () => {
    const now = FIXTURE_A_NOT_AFTER_MS + 3 * MS_PER_DAY;
    const got = inspectCertBytes(CERT_A, now);

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.isExpired).toBe(true);
    expect(got.daysRemaining).toBe(-3);
  });

  it("returns a result rather than throwing when the bytes are not a certificate", () => {
    const got = inspectCertBytes(Buffer.from("this is not a certificate"), Date.UTC(2026, 0, 1));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toMatch(/could not parse certificate/i);
  });
});

describe("certExpiryLevel — classification", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // PAIR 2(b) — THE VACUOUS-GREEN CONTROL.
  //
  // Without this, the entire check could be a constant that never warns, and
  // every "expired" assertion above would still pass. The pair is what makes
  // either half mean anything: the SAME certificate must classify differently
  // on either side of its own notAfter.
  // ───────────────────────────────────────────────────────────────────────────
  it("classifies a comfortably-valid cert as ok, and emits NO message", () => {
    const now = FIXTURE_A_NOT_AFTER_MS - 365 * MS_PER_DAY;
    const inspection = inspectCertBytes(CERT_A, now);

    expect(certExpiryLevel(inspection)).toBe("ok");
    expect(certExpiryMessage(inspection, now)).toBeNull();
  });

  it("classifies the SAME cert as expired once the clock passes notAfter — so the ok above is not a constant", () => {
    const valid = FIXTURE_A_NOT_AFTER_MS - 365 * MS_PER_DAY;
    const lapsed = FIXTURE_A_NOT_AFTER_MS + 1 * MS_PER_DAY;

    expect(certExpiryLevel(inspectCertBytes(CERT_A, valid))).toBe("ok");
    expect(certExpiryLevel(inspectCertBytes(CERT_A, lapsed))).toBe("expired");
    // The inequality is the point: one input, two clocks, two answers.
    expect(certExpiryLevel(inspectCertBytes(CERT_A, valid))).not.toBe(
      certExpiryLevel(inspectCertBytes(CERT_A, lapsed)),
    );
  });

  it("warns inside the threshold and stays quiet just outside it", () => {
    const inside = FIXTURE_A_NOT_AFTER_MS - (CERT_EXPIRY_WARN_DAYS - 1) * MS_PER_DAY;
    const outside = FIXTURE_A_NOT_AFTER_MS - (CERT_EXPIRY_WARN_DAYS + 2) * MS_PER_DAY;

    expect(certExpiryLevel(inspectCertBytes(CERT_A, inside))).toBe("expiring_soon");
    expect(certExpiryLevel(inspectCertBytes(CERT_A, outside))).toBe("ok");
  });

  it("classifies an unreadable cert as unknown, NOT as ok", () => {
    // "The cert is fine" and "we could not read the cert" are different claims;
    // collapsing them is the silent-failure pattern this arc removes.
    const bad = inspectCertBytes(Buffer.from("garbage"), Date.UTC(2026, 0, 1));
    expect(certExpiryLevel(bad)).toBe("unknown");
    expect(certExpiryLevel(bad)).not.toBe("ok");
    expect(certExpiryMessage(bad, Date.UTC(2026, 0, 1))).toMatch(/could not read/i);
  });
});

describe("certExpiryMessage — copy", () => {
  const lapsed = FIXTURE_A_NOT_AFTER_MS + 2 * MS_PER_DAY;
  const soon = FIXTURE_A_NOT_AFTER_MS - 5 * MS_PER_DAY;

  it("names the expiry date and the action the farmer can take themselves", () => {
    const msg = certExpiryMessage(inspectCertBytes(CERT_A, lapsed), lapsed);
    expect(msg).toMatch(/2036-08-18/);
    expect(msg).toMatch(/restart the lightning app/i);
  });

  // ⚠ Same guard as app/web/src/components/actionConfirm/confirmMachine.test.ts:153-154.
  // On a member node the farmer IS the node operator, so this phrasing would
  // route them back to themselves.
  it("never routes the farmer to a node operator — on a member node that is them", () => {
    for (const now of [lapsed, soon]) {
      const msg = certExpiryMessage(inspectCertBytes(CERT_A, now), now) ?? "";
      expect(msg).not.toMatch(/ask your (node )?operator/i);
      expect(msg).not.toMatch(/contact your (node )?operator/i);
    }
    const bad = certExpiryMessage(inspectCertBytes(Buffer.from("x"), 0), 0) ?? "";
    expect(bad).not.toMatch(/ask your (node )?operator/i);
    expect(bad).not.toMatch(/contact your (node )?operator/i);
  });

  // Release reality: this ships as a release and members update by clicking, so
  // the copy reaches nodes that are currently FINE. It must read correctly to
  // someone who has no problem at all — i.e. say nothing to them.
  it("says nothing at all to a node whose cert is healthy", () => {
    const healthy = FIXTURE_A_NOT_AFTER_MS - 500 * MS_PER_DAY;
    expect(certExpiryMessage(inspectCertBytes(CERT_A, healthy), healthy)).toBeNull();
  });
});
