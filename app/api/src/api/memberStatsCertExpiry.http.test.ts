// Route-level coverage for the cert_expiry field on GET /api/member/stats.
//
// ─── THIS TEST IS THE ARC'S CENTRAL CLAIM, NOT A COVERAGE CHORE ─────────────
//
// The whole reason a cert warning can reach a farmer AT ALL is that the fact it
// carries is readable while LND is unreachable. Two independent properties have
// to hold at once, and only a route-level test can observe them together:
//
//   1. /api/member/stats answers 200 during an LND fault. Its two live LND
//      reads sit in their own inner try/catch and only set lnd_live_read_ok
//      false (index.ts:3060-3086); everything else is SQLite. Contrast
//      /api/node/balances, where the live call is the FIRST statement in a
//      single try and the route fails closed to 500 (index.ts:445-465).
//   2. The cert fact itself needs no LND. readCertExpiry.ts is a readFileSync
//      plus a parse — /lnd is a live bind mount, so the bytes are there while
//      every gRPC call is failing.
//
// So the observable this pins is ONE BODY carrying BOTH `lnd_live_read_ok:
// false` AND a non-null `cert_expiry`. A test that asserted them separately
// would pass on an implementation where the cert read rode an LND-dependent
// path and simply happened to be exercised while LND was up.
//
// ⚠ THIS FILE WAS RUN AGAINST PRE-L1 CODE AND FAILED (cert_expiry undefined)
// before the field existed. A route test that is green before the change proves
// nothing about the change.
//
// ⚠ NO LND CONTACT. getLndPeers and isKeysendEnabled are the only two live
// reads this route makes and both are mocked here. LND_DIR points at a scratch
// directory holding a copy of the committed certificate fixture, so the cert
// read is real filesystem work against a real X.509 certificate and no socket
// is opened.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at its own module
// scope. Point it at a scratch dir, same as index.boot.test.ts.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-db-"));
process.env.DB_DIR = TMP_DB;

// A scratch LND dir holding a REAL certificate — the same committed fixture
// certExpiry.test.ts parses (notAfter=Aug 18 23:06:27 2036 GMT). Copied rather
// than symlinked so unlinking it below cannot touch the fixture itself.
const TMP_LND = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-lnd-"));
const FIXTURE_CERT = path.join(__dirname, "..", "lightning", "__fixtures__", "lnd-tls-a.crt");
const SCRATCH_CERT = path.join(TMP_LND, "tls.cert");
fs.copyFileSync(FIXTURE_CERT, SCRATCH_CERT);
process.env.LND_DIR = TMP_LND;

// The route only reaches getLndPeers when a hub pubkey is configured
// (index.ts:3068). Set one so BOTH live reads run and both can be faulted.
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

const lndState = vi.hoisted(() => ({ throws: false }));

// importOriginal + spread rather than a bare factory: index.ts imports sixteen
// names from this module, and a factory would silently replace the fifteen this
// route never calls with undefined.
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndPeers: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: certificate has expired");
      return { peers: [{ public_key: HUB }] };
    },
    isKeysendEnabled: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: certificate has expired");
      return true;
    },
  };
});

const roleState = vi.hoisted(() => ({ node: null as { node_role?: string; membership_status?: string } | null }));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");

// Migrations run from main() behind the require.main guard (index.ts:247-249),
// so importing index.ts does NOT create tables. This route SELECTs from
// lnd_channels and payments_forwarded, so the schema has to exist or the outer
// catch turns every case into a 500 and the suite passes for the wrong reason.
const { runMigrations } = await import("../db/migrate");
runMigrations();

// ─── Minimal req/res doubles (same shape as lndProbeRoute.http.test.ts) ──────

interface Captured {
  status: number | null;
  headers: Record<string, unknown>;
  body: string;
  ended: boolean;
}

function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, body: "", ended: false };
  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      captured.ended = true;
      return res;
    },
  };
  return { res, captured };
}

async function get(url: string): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { method: "GET", url, headers: {} } as any;
  await handleRequest(req, res);
  return captured;
}

const STATS_PATH = "/api/member/stats";

beforeEach(() => {
  lndState.throws = false;
  roleState.node = { node_role: "member", membership_status: "active" };
  if (!fs.existsSync(SCRATCH_CERT)) fs.copyFileSync(FIXTURE_CERT, SCRATCH_CERT);
});

afterAll(() => {
  fs.rmSync(TMP_LND, { recursive: true, force: true });
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CTRL-3 — THE PAIR. One body, both facts. And the healthy twin.
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/member/stats carries the cert fact THROUGH an LND fault", () => {
  it("⚠ 200 with lnd_live_read_ok:false AND a non-null cert_expiry IN THE SAME BODY", async () => {
    lndState.throws = true;
    const out = await get(STATS_PATH);

    // 500 here would mean the route stopped surviving the fault — the property
    // the entire member-side warning depends on.
    expect(out.status).toBe(200);

    const body = JSON.parse(out.body);
    expect(body.lnd_live_read_ok).toBe(false);
    expect(body.cert_expiry).not.toBeNull();
    expect(body.cert_expiry.level).toBe("ok"); // the fixture is valid until 2036
    expect(typeof body.cert_expiry.not_after_ms).toBe("number");
  });

  it("the healthy twin: live reads succeed, cert is ok, still 200", async () => {
    lndState.throws = false;
    const out = await get(STATS_PATH);

    expect(out.status).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.lnd_live_read_ok).toBe(true);
    expect(body.cert_expiry.level).toBe("ok");
    // "ok" carries no message — certExpiry.ts:159 returns null for a healthy cert.
    expect(body.cert_expiry.message).toBeNull();
  });

  it("the two cases actually differ — neither field is a constant", async () => {
    lndState.throws = true;
    const faulted = JSON.parse((await get(STATS_PATH)).body);
    lndState.throws = false;
    const healthy = JSON.parse((await get(STATS_PATH)).body);

    expect(faulted.lnd_live_read_ok).not.toBe(healthy.lnd_live_read_ok);
    // ...while the cert fact is IDENTICAL across both. That is the point: the
    // cert reading is independent of LND's reachability, not merely correlated
    // with it.
    expect(faulted.cert_expiry.level).toBe(healthy.cert_expiry.level);
    expect(faulted.cert_expiry.not_after_ms).toBe(healthy.cert_expiry.not_after_ms);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// unknown TRAVELS TRUTHFULLY, and the value is computed PER REQUEST.
// ═══════════════════════════════════════════════════════════════════════════

describe("the API does not launder `unknown` into `ok`", () => {
  it("an absent tls.cert reports level unknown with a reason, not ok and not null", async () => {
    fs.unlinkSync(SCRATCH_CERT);
    const body = JSON.parse((await get(STATS_PATH)).body);

    expect(body.cert_expiry).not.toBeNull();
    expect(body.cert_expiry.level).toBe("unknown");
    expect(body.cert_expiry.level).not.toBe("ok");
    expect(body.cert_expiry.message).toMatch(/could not read/i);
    // Nothing to report a date from, and the field says so rather than guessing.
    expect(body.cert_expiry.not_after_ms).toBeNull();
  });

  it("⚠ the level is recomputed PER REQUEST, not cached at boot", async () => {
    // Same process, same handler, two requests either side of the file
    // disappearing. A boot-time read or a 24h-rate-limited cached outcome
    // (maybeCheckCertExpiry's shape) would return the stale `ok` here.
    const before = JSON.parse((await get(STATS_PATH)).body);
    expect(before.cert_expiry.level).toBe("ok");

    fs.unlinkSync(SCRATCH_CERT);
    const after = JSON.parse((await get(STATS_PATH)).body);
    expect(after.cert_expiry.level).toBe("unknown");

    fs.copyFileSync(FIXTURE_CERT, SCRATCH_CERT);
    const restored = JSON.parse((await get(STATS_PATH)).body);
    expect(restored.cert_expiry.level).toBe("ok");
  });
});
