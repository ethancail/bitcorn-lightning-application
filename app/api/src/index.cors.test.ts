// The private-origin CORS check, driven through the real exported
// handleRequest. With no caller authentication on port 3101, this check is what
// stops a page on someone else's site from reading the API and from passing the
// preflight that x-bitcorn-confirm forces on capital routes.
//
// THE BUG THIS PINS: the old check matched the Origin's hostname as TEXT —
// startsWith("10.") and friends — so a public DNS name such as
// `10.attacker.example` passed as private. The REJECTED table below holds those
// names; they were run against the pre-change prefix check and went red (see the
// commit message for the recorded output). Re-run them that way before trusting
// a green here.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import { beforeAll, describe, expect, it } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cors-test-"));
process.env.DB_DIR = TMP_DB;

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

beforeAll(async () => {
  ({ handleRequest } = await import("./index"));
});

type Captured = { status: number; headers: Record<string, string> };

/** Drive handleRequest; capture the status and every header set on the response. */
function call(method: string, url: string, origin: string | undefined): Promise<Captured> {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = {
    ...(origin !== undefined && { origin }),
    ...(method === "OPTIONS" && {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-bitcorn-confirm",
    }),
  };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  req.end();

  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    let status = 0;
    const res = {
      setHeader(k: string, v: any) {
        headers[k.toLowerCase()] = String(v);
      },
      getHeader(k: string) {
        return headers[k.toLowerCase()];
      },
      writeHead(s: number, h?: Record<string, any>) {
        status = s;
        if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
        return res;
      },
      end() {
        resolve({ status, headers });
      },
      write() {
        return true;
      },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
  });
}

const preflight = (origin: string | undefined) => call("OPTIONS", "/api/pay", origin);

// ─── PERMITS ────────────────────────────────────────────────────────────────
// One address from each private range, loopback, the IPv6 forms, the two names,
// and ports present, absent, and arbitrary.
const ACCEPTED: Array<[label: string, origin: string]> = [
  ["10/8", "http://10.0.0.5:3200"],
  ["172.16/12 (low edge)", "http://172.16.0.1:3200"],
  ["172.16/12 (high edge)", "http://172.31.255.254:3200"],
  ["192.168/16", "http://192.168.1.20:3200"],
  ["100.64/10 (low edge)", "http://100.64.0.1:3200"],
  ["100.64/10 (high edge)", "http://100.127.255.254:3200"],
  ["100.64/10 (a real tailnet node)", "http://100.126.33.13:3200"],
  ["127/8", "http://127.0.0.1:3200"],
  ["127/8 (not just .1)", "http://127.0.0.2:3200"],
  ["IPv6 loopback", "http://[::1]:3200"],
  ["IPv6 fc00::/7 (Tailscale fd7a:)", "http://[fd7a:115c:a1e0::1]:3200"],
  ["localhost", "http://localhost:3200"],
  ["umbrel.local", "http://umbrel.local:3200"],
  ["no port", "http://umbrel.local"],
  ["any port, https", "https://localhost:5173"],
];

// ─── FORBIDS ────────────────────────────────────────────────────────────────
const REJECTED: Array<[label: string, origin: string]> = [
  // Public names that merely START like a private address — the bug.
  ["spoofed 10.", "http://10.attacker.example"],
  ["spoofed 192.168.", "http://192.168.attacker.example:3200"],
  ["spoofed 172.16.", "http://172.16.attacker.example"],
  ["spoofed 100.64.", "http://100.64.attacker.example"],
  ["spoofed 100. with lenient parseInt", "http://100.99zz.evil.example"],
  // Public addresses, including just outside each range edge.
  ["public IPv4", "http://8.8.8.8:3200"],
  ["just below 100.64/10", "http://100.63.255.255"],
  ["just above 100.64/10", "http://100.128.0.1"],
  ["just above 172.16/12", "http://172.32.0.1"],
  ["public IPv6", "http://[2001:4860:4860::8888]:3200"],
  // Public names, including ones built around the accepted names.
  ["public name", "https://example.com"],
  ["localhost as a prefix", "http://localhost.attacker.example"],
  [".local not at the end", "http://umbrel.local.attacker.example"],
  // Unparseable.
  ["unparseable", "not a url"],
  ["opaque origin", "null"],
];

describe("CORS: private origins get Access-Control-Allow-Origin", () => {
  it.each(ACCEPTED)("PERMITS %s (%s)", async (_label, origin) => {
    const r = await preflight(origin);
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(origin);
    expect(r.headers["vary"]).toBe("Origin");
  });
});

describe("CORS: everything else gets no Access-Control-Allow-Origin", () => {
  it.each(REJECTED)("FORBIDS %s (%s)", async (_label, origin) => {
    const r = await preflight(origin);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["vary"]).toBe("Origin");
  });

  it("FORBIDS a spoofed name on a non-preflight request too", async () => {
    const r = await call("GET", "/health", "http://10.attacker.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CORS: no Origin header is unchanged", () => {
  it("server-to-server callers still get *", async () => {
    const r = await preflight(undefined);
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["vary"]).toBe("Origin");
  });
});
