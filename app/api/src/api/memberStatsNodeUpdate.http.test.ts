// Route-level coverage for node_update_notice on GET /api/member/stats
// (node-version-alert, R4). The field carries the API-written member line, or
// null: before the first read, and on a node whose LND is current.
//
// The value is the sync loop's in-memory read (lightning/lndVersion.ts), so it
// needs no LND at request time — the LND-fault case below pins that.
//
// Harness: memberStatsCertExpiry.http.test.ts's (scratch DB, scratch LND dir
// with the committed cert fixture, the two live reads mocked).

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-nva-db-"));
process.env.DB_DIR = TMP_DB;

const TMP_LND = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-nva-lnd-"));
fs.copyFileSync(
  path.join(__dirname, "..", "lightning", "__fixtures__", "lnd-tls-a.crt"),
  path.join(TMP_LND, "tls.cert"),
);
process.env.LND_DIR = TMP_LND;

const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

const lndState = vi.hoisted(() => ({ throws: false }));

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndPeers: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: connection refused");
      return { peers: [{ public_key: HUB }] };
    },
    isKeysendEnabled: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: connection refused");
      return true;
    },
  };
});

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "member", membership_status: "active" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { recordLndVersion, resetLndVersionForTests } = await import("../lightning/lndVersion");

const RULED_MEMBER_TEXT =
  "Your Lightning Node app is out of date, and part of it has stopped working. " +
  "Update it in your Umbrel's App Store, and update Bitcoin Node and Electrs too if you have them.";

async function stats(): Promise<{ status: number | null; body: any }> {
  let status: number | null = null;
  let raw = "";
  const res: any = {
    setHeader() {},
    writeHead(s: number) { status = s; return res; },
    end(chunk?: string) { if (chunk) raw += chunk; return res; },
  };
  await handleRequest({ method: "GET", url: "/api/member/stats", headers: {} } as any, res);
  return { status, body: JSON.parse(raw) };
}

beforeEach(() => {
  lndState.throws = false;
  resetLndVersionForTests();
});

afterAll(() => {
  fs.rmSync(TMP_LND, { recursive: true, force: true });
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

describe("GET /api/member/stats carries node_update_notice", () => {
  it("an LND below 0.21.2 → the ruled member line", async () => {
    recordLndVersion("0.20.0-beta commit=v0.20.0-beta");
    const r = await stats();
    expect(r.status).toBe(200);
    expect(r.body.node_update_notice).toBe(RULED_MEMBER_TEXT);
  });

  it("a current LND → null", async () => {
    recordLndVersion("0.21.8-beta commit=v0.21.8-beta");
    const r = await stats();
    expect(r.status).toBe(200);
    expect(r.body.node_update_notice).toBeNull();
  });

  it("before the first read → null, present on the wire (not absent)", async () => {
    const r = await stats();
    expect(r.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(r.body, "node_update_notice")).toBe(true);
    expect(r.body.node_update_notice).toBeNull();
  });

  it("survives an LND fault: the notice rides the same 200 as lnd_live_read_ok:false", async () => {
    recordLndVersion("0.20.0-beta commit=v0.20.0-beta");
    lndState.throws = true;
    const r = await stats();
    expect(r.status).toBe(200);
    expect(r.body.lnd_live_read_ok).toBe(false);
    expect(r.body.node_update_notice).toBe(RULED_MEMBER_TEXT);
  });
});
