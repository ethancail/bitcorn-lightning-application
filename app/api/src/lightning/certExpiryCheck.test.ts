// The day-scale rate limit, and the reporting it gates.
//
// NO DB, NO MOCKS. This imports certExpiryCheck.ts, which reaches only
// readCertExpiry -> certExpiry -> lndPaths, none of which touch ../db. That is
// the point of keeping the decision out of advisorScheduler.ts: importing the
// scheduler would pull in ../api/read -> ../db, and db/index.ts:14 opens SQLite
// at module scope, so this file would create a store just by existing.
//
// LND_DIR is pointed at a scratch dir with a real fixture certificate, and the
// clock is injected, so "expiring soon" and "expired" are reached by moving nowMs
// rather than by shipping a broken artifact.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const FIXTURES = path.join(__dirname, "__fixtures__");
const CERT_A = fs.readFileSync(path.join(FIXTURES, "lnd-tls-a.crt"));
/** openssl: notAfter=Aug 18 23:06:27 2036 GMT */
const NOT_AFTER_MS = Date.UTC(2036, 7, 18, 23, 6, 27);
const DAY = 24 * 60 * 60 * 1000;

let scratchDir: string;
const savedLndDir = process.env.LND_DIR;

/** Load a fresh copy so lndPaths.ts re-reads LND_DIR and state starts clean. */
async function freshCheck(seedCert: Buffer | null) {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-check-"));
  if (seedCert) fs.writeFileSync(path.join(scratchDir, "tls.cert"), seedCert);
  process.env.LND_DIR = scratchDir;
  vi.resetModules();
  return await import("./certExpiryCheck");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (scratchDir && fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  if (savedLndDir === undefined) delete process.env.LND_DIR;
  else process.env.LND_DIR = savedLndDir;
});

describe("the day-scale guard", () => {
  it("runs on the first tick", async () => {
    const m = await freshCheck(CERT_A);
    const out = m.maybeCheckCertExpiry(NOT_AFTER_MS - 400 * DAY);
    expect(out.ran).toBe(true);
    expect(out.level).toBe("ok");
  });

  it("skips a tick 15 minutes later — the scheduler's own cadence", async () => {
    const m = await freshCheck(CERT_A);
    const t0 = NOT_AFTER_MS - 400 * DAY;

    expect(m.maybeCheckCertExpiry(t0).ran).toBe(true);
    expect(m.maybeCheckCertExpiry(t0 + 15 * 60 * 1000).ran).toBe(false);
    expect(m.maybeCheckCertExpiry(t0 + 23 * 60 * 60 * 1000).ran).toBe(false);
  });

  // THE CONTROL for the guard: a rate limit that never opens again would pass
  // every "skips" assertion above while checking exactly once per process life.
  it("runs again once a full day has passed", async () => {
    const m = await freshCheck(CERT_A);
    const t0 = NOT_AFTER_MS - 400 * DAY;

    expect(m.maybeCheckCertExpiry(t0).ran).toBe(true);
    expect(m.maybeCheckCertExpiry(t0 + 12 * 60 * 60 * 1000).ran).toBe(false);
    expect(m.maybeCheckCertExpiry(t0 + m.CERT_CHECK_INTERVAL_MS).ran).toBe(true);
    // ...and the window restarts from the new check, not from t0.
    expect(m.maybeCheckCertExpiry(t0 + m.CERT_CHECK_INTERVAL_MS + 60_000).ran).toBe(false);
  });

  it("resetCertExpiryCheckState makes the next tick run — a restart re-checks immediately", async () => {
    const m = await freshCheck(CERT_A);
    const t0 = NOT_AFTER_MS - 400 * DAY;

    expect(m.maybeCheckCertExpiry(t0).ran).toBe(true);
    expect(m.maybeCheckCertExpiry(t0 + 60_000).ran).toBe(false);
    m.resetCertExpiryCheckState();
    expect(m.maybeCheckCertExpiry(t0 + 60_000).ran).toBe(true);
  });
});

describe("what it reports", () => {
  it("says nothing for a healthy cert — quiet on nodes with nothing wrong", async () => {
    const m = await freshCheck(CERT_A);
    const out = m.maybeCheckCertExpiry(NOT_AFTER_MS - 400 * DAY);

    expect(out.level).toBe("ok");
    expect(out.message).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("warns inside the 30-day window", async () => {
    const m = await freshCheck(CERT_A);
    const out = m.maybeCheckCertExpiry(NOT_AFTER_MS - 10 * DAY);

    expect(out.level).toBe("expiring_soon");
    expect(out.message).toMatch(/expires on 2036-08-18/);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(String((console.warn as any).mock.calls[0][0])).toMatch(/^\[lnd-cert\] expiring_soon:/);
  });

  it("escalates to console.error once expired", async () => {
    const m = await freshCheck(CERT_A);
    const out = m.maybeCheckCertExpiry(NOT_AFTER_MS + 4 * DAY);

    expect(out.level).toBe("expired");
    expect(console.error).toHaveBeenCalledOnce();
    expect(String((console.error as any).mock.calls[0][0])).toMatch(/^\[lnd-cert\] expired:/);
    // console.warn is NOT also used — one line per finding, not two.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports unknown, not ok, when the cert file is absent", async () => {
    const m = await freshCheck(null); // no tls.cert written
    const out = m.maybeCheckCertExpiry(Date.UTC(2026, 0, 1));

    expect(out.ran).toBe(true);
    expect(out.level).toBe("unknown");
    expect(out.message).toMatch(/could not read/i);
  });

  it("never routes the farmer to a node operator", async () => {
    const m = await freshCheck(CERT_A);
    const out = m.maybeCheckCertExpiry(NOT_AFTER_MS + 1 * DAY);
    expect(out.message ?? "").not.toMatch(/ask your (node )?operator/i);
    expect(out.message ?? "").not.toMatch(/contact your (node )?operator/i);
  });
});
