// PAIR 1 — fix A: cert-change-gated client rebuild.
//
// ─── THE OBSERVABLE IS EXTERNAL, NOT SELF-REPORTED ──────────────────────────
//
// These tests do not trust a counter the module keeps about itself. ln-service
// is mocked and the assertion counts how many times `authenticatedLndGrpc` was
// actually INVOKED. A "rebuild" that never calls the constructor is not a
// rebuild, and a counter reporting 0 while the constructor ran six times would
// satisfy a self-report and fail this. The module's own counter is asserted too,
// but only alongside the external one — never instead of it.
//
// ─── WHY NO gRPC CLIENT IS EVER CONSTRUCTED ─────────────────────────────────
//
// ln-service is mocked wholesale, so no credentials are built and no socket is
// opened. LND_DIR points at a scratch dir under os.tmpdir(). lnd.ts reads
// LND_DIR at MODULE SCOPE (lnd.ts:34), so each case sets the env var and then
// dynamically imports through a reset module registry — a top-level import
// would freeze the path at whatever the first test happened to set.
//
// lnd.ts imports neither ./db nor better-sqlite3 (verified: its only imports are
// ln-service, crypto, fs, path, ../config/env), so nothing here can create a
// SQLite store.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/** Counts real invocations of the LND client constructor. THE observable. */
let constructorCalls = 0;

vi.mock("ln-service", () => {
  const stub = () => vi.fn();
  return {
    authenticatedLndGrpc: () => {
      constructorCalls += 1;
      // A distinct identity per construction, so "the handle changed" is
      // checkable rather than inferred.
      return { lnd: { __construction: constructorCalls }, logger: {} };
    },
    // lnd.ts destructures these at import time; they must exist as names.
    getWalletInfo: stub(),
    getIdentity: stub(),
    getPeers: stub(),
    getChannels: stub(),
    getInvoices: stub(),
    getForwards: stub(),
    getChainBalance: stub(),
    getPendingChainBalance: stub(),
    getChainTransactions: stub(),
    addPeer: stub(),
    openChannel: stub(),
    closeChannel: stub(),
    getPendingChannels: stub(),
    createInvoice: stub(),
    getRouteToDestination: stub(),
    payViaRoutes: stub(),
    createChainAddress: stub(),
    getUtxos: stub(),
    signMessage: stub(),
    verifyMessage: stub(),
    payViaPaymentDetails: stub(),
    sendToChainAddress: stub(),
    getChainFeeRate: stub(),
    updateAlias: stub(),
  };
});

const FIXTURES = path.join(__dirname, "__fixtures__");
const CERT_A = fs.readFileSync(path.join(FIXTURES, "lnd-tls-a.crt"));
const CERT_B = fs.readFileSync(path.join(FIXTURES, "lnd-tls-b.crt"));

let scratchDir: string;
let certPath: string;
const savedLndDir = process.env.LND_DIR;

/** Build a scratch /lnd tree: tls.cert + the admin.macaroon lnd.ts expects. */
function seedLndDir(certBytes: Buffer): void {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lnd-cert-test-"));
  certPath = path.join(scratchDir, "tls.cert");
  fs.writeFileSync(certPath, certBytes);
  // BITCOIN_NETWORK is unset in tests, so env.ts:11 yields "mainnet".
  const macDir = path.join(scratchDir, "data", "chain", "bitcoin", "mainnet");
  fs.mkdirSync(macDir, { recursive: true });
  fs.writeFileSync(path.join(macDir, "admin.macaroon"), Buffer.from("not-a-real-macaroon"));
  process.env.LND_DIR = scratchDir;
}

/** Fresh module registry so lnd.ts re-reads LND_DIR and resets its singleton. */
async function freshLndModule() {
  vi.resetModules();
  return await import("./lnd");
}

beforeEach(() => {
  constructorCalls = 0;
});

afterEach(() => {
  if (scratchDir && fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  if (savedLndDir === undefined) delete process.env.LND_DIR;
  else process.env.LND_DIR = savedLndDir;
});

describe("fix A — the client is rebuilt only when the cert BYTES change", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // PAIR 1(b) — THE DONE-WHEN. Written before the hash gate existed, and
  // confirmed RED against a rebuild-on-every-call implementation.
  //
  // This is the dangerous half. A self-healing loop that rebuilds past a
  // permanent credential fault is the documented failure mode wearing a fix's
  // clothes: it would retry forever, hiding the fault instead of surfacing it.
  // With the cert unchanged, the constructor must run exactly ONCE no matter
  // how many calls fail.
  // ───────────────────────────────────────────────────────────────────────────
  it("does NOT rebuild after N consecutive failed LND calls when the cert is UNCHANGED", async () => {
    seedLndDir(CERT_A);
    const lnd = await freshLndModule();

    // First call constructs the client. That is construction, not a rebuild.
    const first = lnd.getLndClient();
    expect(constructorCalls).toBe(1);

    // Now simulate N failed LND calls. A consumer whose call threw simply
    // reaches for the client again on its next attempt — that is what the 15s
    // sync loop and every route handler do. The cert on disk never changes.
    const N = 5;
    for (let i = 0; i < N; i += 1) {
      lnd.getLndClient();
    }

    // THE ASSERTION: no rebuild happened, on either observable.
    expect(constructorCalls).toBe(1);
    expect(lnd.getLndClientRebuildCount()).toBe(0);
    // Same handle throughout — nothing was silently swapped.
    expect(lnd.getLndClient()).toBe(first);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PAIR 1(a) — the recovery half.
  // ───────────────────────────────────────────────────────────────────────────
  it("rebuilds when the cert bytes change, and the next call gets the new client", async () => {
    seedLndDir(CERT_A);
    const lnd = await freshLndModule();

    const before = lnd.getLndClient();
    expect(constructorCalls).toBe(1);
    expect(lnd.getLndClientRebuildCount()).toBe(0);

    // LND regenerates the cert. /lnd is a live bind mount, so the container
    // sees the new bytes immediately — no restart, no remount.
    fs.writeFileSync(certPath, CERT_B);

    const after = lnd.getLndClient();

    expect(constructorCalls).toBe(2);
    expect(lnd.getLndClientRebuildCount()).toBe(1);
    // A genuinely different handle, not the same object handed back.
    expect(after).not.toBe(before);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // HASH, NEVER mtime. mtime moves without content moving — a touch, a backup
  // restore, a container remount. Gating on it would rebuild for no reason and
  // reintroduce exactly the spin this design exists to prevent.
  // ───────────────────────────────────────────────────────────────────────────
  it("does NOT rebuild when only the cert's mtime moves and the bytes are identical", async () => {
    seedLndDir(CERT_A);
    const lnd = await freshLndModule();

    lnd.getLndClient();
    expect(constructorCalls).toBe(1);

    const before = fs.statSync(certPath).mtimeMs;
    // Rewrite the SAME bytes, then force mtime well past the original.
    fs.writeFileSync(certPath, CERT_A);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(certPath, future, future);
    expect(fs.statSync(certPath).mtimeMs).toBeGreaterThan(before);

    lnd.getLndClient();

    expect(constructorCalls).toBe(1);
    expect(lnd.getLndClientRebuildCount()).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The gate order at lnd.ts:66 must not move: isLndAvailable() runs BEFORE the
  // memo check, so an absent cert throws even while a working client is cached.
  // lndHealth.ts:285-291 documents that disagreement deliberately, and
  // APP_OWN_RE (lndHealth.ts:179) keys on this exact message.
  // ───────────────────────────────────────────────────────────────────────────
  it("still throws the app's own files-not-available error when the cert is deleted, even with a cached client", async () => {
    seedLndDir(CERT_A);
    const lnd = await freshLndModule();

    lnd.getLndClient();
    expect(constructorCalls).toBe(1);

    fs.rmSync(certPath);

    expect(() => lnd.getLndClient()).toThrow(/LND files not available/);
    // The throw must not have quietly rebuilt anything on the way out.
    expect(constructorCalls).toBe(1);
  });
});
