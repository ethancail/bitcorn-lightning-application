// The treasury's token self-mint is the one timer-driven path that reaches this
// API over HTTP: refreshLocalToken() on the treasury POSTs to
// http://127.0.0.1:${PORTS.userApi}/api/subscription/token (tokenRefresh.ts).
// The cross-site mutation guard in handleRequest refuses a present non-private
// Origin and any non-JSON Content-Type, so this pins that the self-mint as
// ACTUALLY SENT gets past it.
//
// ⚠ REAL TRANSPORT, ON PURPOSE. handleRequest is served on a real local port
// and the request is built by the real refreshLocalToken() and sent by Node's
// real global fetch. A hand-built request object would only measure the headers
// this file chose to write; this measures what Node puts on the wire. Only LND
// is a double, at the lnd.ts wrapper boundary.
//
// NEGATIVE CONTROL (recorded in the commit): change tokenRefresh.ts's
// "Content-Type": "application/json" to "text/plain" and this goes red with 415.

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-self-mint-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;
// Unset, so refreshLocalToken takes the on-treasury localhost branch.
delete process.env.TREASURY_API_URL;

/** A fake signature the verify double can decode: [pubkey, signed string]. */
function sign(pubkey: string, message: string): string {
  return "fakesig" + Buffer.from(JSON.stringify([pubkey, message])).toString("base64");
}

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndInfo: async () => ({ public_key: TREASURY }),
    lndSignMessage: async (message: string) => sign(TREASURY, message),
    lndVerifyMessage: async (message: string, signature: string) => {
      const [pubkey, signed] = JSON.parse(Buffer.from(signature.slice(7), "base64").toString()) as [string, string];
      return signed === message ? pubkey : "02" + "ee".repeat(32);
    },
  };
});

let server: http.Server;
let refreshLocalToken: typeof import("./tokenRefresh").refreshLocalToken;
/** Headers exactly as they arrived at the socket, per request. */
const arrived: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  let handle: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;
  server = http.createServer((req, res) => {
    arrived.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    void handle!(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // PORTS.userApi is read at module load, so the port must be known before the
  // first import that pulls in config/ports.
  process.env.PORT = String((server.address() as AddressInfo).port);

  const { handleRequest } = await import("../index");
  handle = handleRequest;
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ refreshLocalToken } = await import("./tokenRefresh"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("treasury self-mint over real HTTP", () => {
  it("gets past the cross-site guard and mints", async () => {
    const result = await refreshLocalToken();

    const tokenCalls = arrived.filter((a) => a.method === "POST" && a.url === "/api/subscription/token");
    expect(tokenCalls).toHaveLength(1);
    const headers = tokenCalls[0].headers;
    // Recorded, not just asserted, so a run shows what Node actually sent.
    console.info(
      `[self-mint] arrived headers: origin=${JSON.stringify(headers.origin ?? null)} ` +
        `content-type=${JSON.stringify(headers["content-type"] ?? null)} ` +
        `sec-fetch-site=${JSON.stringify(headers["sec-fetch-site"] ?? null)}`,
    );
    // Past the guard: not refused as cross-site or wrong media type, and the
    // token route minted. Asserted BEFORE the header checks so that a refusal
    // by the guard — not a header comparison — is what turns this red.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, scope: "full" });

    expect(headers.origin, "Node's fetch sent an Origin header").toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });
});
