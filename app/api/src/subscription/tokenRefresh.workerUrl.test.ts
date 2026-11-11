// C14 (the treasury-price-trust arc chat's addition, not in the spec): an
// http:// api_url supplied by the WORKER is refused, and an http:// URL from
// the node's own env is allowed (spec §3.5, ruling 2). Both directions, each
// with its anti-vacuity case.
//
// No LND and no network: getLndInfo / lndSignMessage are doubles; the Worker
// and the treasury are one stubbed global fetch that records every URL.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-worker-url-"));
process.env.DB_DIR = TMP;
process.env.TREASURY_PUBKEY = "02" + "11".repeat(32);
process.env.COINBASE_WORKER_URL = "https://worker.test";
delete process.env.TREASURY_API_URL;

const MEMBER = "03" + "aa".repeat(32);

vi.mock("../lightning/lnd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lightning/lnd")>()),
  getLndInfo: async () => ({ public_key: MEMBER }) as any,
  lndSignMessage: async () => "sig",
}));

const net = vi.hoisted(() => ({ urls: [] as string[], workerApiUrl: "" }));

let refreshLocalToken: typeof import("./tokenRefresh").refreshLocalToken;
let getResolvedTreasuryBaseUrl: typeof import("./tokenRefresh").getResolvedTreasuryBaseUrl;
let ENV: typeof import("../config/env").ENV;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    net.urls.push(url);
    if (url.endsWith("/treasury-info")) {
      return new Response(JSON.stringify({ api_url: net.workerApiUrl, subscription_public_key: null }), { status: 200 });
    }
    const now = Math.floor(Date.now() / 1000);
    return new Response(JSON.stringify({ jwt: "h.p.s", scope: "payment", issued_at_sec: now, expires_at_sec: now + 86400 }), { status: 200 });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ refreshLocalToken, getResolvedTreasuryBaseUrl } = await import("./tokenRefresh"));
  ({ ENV } = await import("../config/env"));
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  net.urls = [];
  ENV.treasuryApiUrl = "";
});

describe("C14 — the Worker-supplied treasury URL must be https", () => {
  it("an http:// api_url from the Worker is refused: no request reaches it", async () => {
    net.workerApiUrl = "http://treasury.plain.test";
    const r = await refreshLocalToken();
    expect(
      net.urls.filter((u) => u.startsWith("http://treasury.plain.test")),
      "C14: the member called a Worker-supplied http:// URL",
    ).toEqual([]);
    expect(r).toMatchObject({ ok: false, reason: "transport_error" });

    // Anti-vacuity: an https:// api_url from the Worker IS used.
    net.workerApiUrl = "https://treasury.tls.test";
    const ok = await refreshLocalToken();
    expect(ok.ok).toBe(true);
    expect(net.urls).toContain("https://treasury.tls.test/api/subscription/token");
    expect(getResolvedTreasuryBaseUrl()).toBe("https://treasury.tls.test");
  });

  it("an http:// URL from the node's own env is allowed (development, the treasury's loopback)", async () => {
    ENV.treasuryApiUrl = "http://127.0.0.1:3999";
    net.workerApiUrl = "https://never-asked.test";
    const r = await refreshLocalToken();
    expect(r.ok, "C14: an operator-set http:// URL was refused").toBe(true);
    expect(net.urls).toEqual(["http://127.0.0.1:3999/api/subscription/token"]);
    expect(getResolvedTreasuryBaseUrl()).toBe("http://127.0.0.1:3999");
  });
});
