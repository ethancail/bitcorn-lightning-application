// Route-level tests for GET /api/daybreak/edition — the member-reachable proxy
// in front of the Worker's GET /daybreak/edition (spec §3.4.2, first test 31,
// bitcorn-research specs/2026-09-21-bitcorn-daybreak-spec.md).
//
// THE PROPERTY: the proxy KEEPS THE REASON. Each Worker outcome maps to its own
// proxy reason, and no two distinct outcomes share one. In particular:
//   - the node's own auth failures (401 missing, 401 invalid, 403 scope) stay
//     distinct from service failures, and from each other;
//   - the Worker's OWN 503 reason is passed through, never dropped into a
//     generic upstream code — the spec names both patterns it must not follow:
//     /api/commodity-prices' collapse of every non-OK into 502, and
//     valuationClient.ts' upstream_error, which keeps the 401s but drops the
//     503's reason.
// And codes only: no free-text detail from the Worker or the transport reaches
// the response body.
//
// ⚠ NO NETWORK. workerFetch is replaced by a scripted double. WorkerFetchError
// stays the REAL class (importOriginal + spread), so the route's instanceof
// checks are exercised against what production throws.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at module scope.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-daybreak-db-"));
process.env.DB_DIR = TMP_DB;

type Scripted =
  | { kind: "response"; status: number; body: string }
  | { kind: "throw"; reason: "not_configured" | "transport_error"; message: string };

const workerState = vi.hoisted(() => ({
  next: null as Scripted | null,
  calls: [] as string[],
}));

vi.mock("../lib/workerFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/workerFetch")>();
  return {
    ...actual,
    workerFetch: async (p: string) => {
      workerState.calls.push(p);
      const s = workerState.next;
      if (!s) throw new Error("test did not script the Worker");
      if (s.kind === "throw") throw new actual.WorkerFetchError(s.message, s.reason);
      return new Response(s.body, { status: s.status, headers: { "Content-Type": "application/json" } });
    },
  };
});

const roleState = vi.hoisted(() => ({ node: null as { node_role?: string } | null }));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");

// ─── Minimal req/res doubles (same shape as memberStatsCertExpiry.http.test.ts) ─

interface Captured {
  status: number | null;
  body: string;
}

async function getEdition(): Promise<{ status: number | null; body: any; raw: string }> {
  const captured: Captured = { status: null, body: "" };
  const res: any = {
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  };
  await handleRequest({ method: "GET", url: "/api/daybreak/edition", headers: {} } as any, res);
  let body: any = null;
  try {
    body = JSON.parse(captured.body);
  } catch {
    body = null;
  }
  return { status: captured.status, body, raw: captured.body };
}

function workerReturns(status: number, body: unknown) {
  workerState.next = { kind: "response", status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

beforeEach(() => {
  workerState.next = null;
  workerState.calls = [];
  roleState.node = { node_role: "member" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

const EDITION = {
  state: "current",
  dueDate: "2026-09-23",
  edition: { date: "2026-09-23", content: { lead: "Corn opened flat.", workerOwned: { z: { status: "unavailable", reason: "fetch_failed" } } } },
};

// ═══════════════════════════════════════════════════════════════════════════
// The permitting control leads: the edition IS there.
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/daybreak/edition — the edition reaches the member", () => {
  it("PERMITS: a Worker 200 is relayed as 200 with the Worker's body, via /daybreak/edition", async () => {
    workerReturns(200, EDITION);
    const out = await getEdition();
    expect(out.status).toBe(200);
    expect(out.body).toEqual(EDITION);
    expect(workerState.calls).toEqual(["/daybreak/edition"]);
  });

  it("a 200 whose body is not JSON is its own reason, not a relayed 200", async () => {
    workerReturns(200, "<html>not json</html>");
    const out = await getEdition();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "invalid_worker_response" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The guard — the same one the valuation reads use (assertNonEmpty).
// ═══════════════════════════════════════════════════════════════════════════

describe("guard: assertNonEmpty(node_role), as on the valuation reads", () => {
  for (const role of ["member", "treasury"]) {
    it(`PERMITS node_role=${role}: the Worker is called`, async () => {
      roleState.node = { node_role: role };
      workerReturns(200, EDITION);
      const out = await getEdition();
      expect(out.status).toBe(200);
      expect(workerState.calls).toHaveLength(1);
    });
  }

  it("FORBIDS a node with no role: 403, and the Worker is never called", async () => {
    roleState.node = { node_role: "" };
    workerReturns(200, EDITION);
    const out = await getEdition();
    expect(out.status).toBe(403);
    expect(workerState.calls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 31 — proxy reason mapping.
// ═══════════════════════════════════════════════════════════════════════════

type Outcome = {
  name: string;
  script: () => void;
  status: number;
  body: Record<string, unknown>;
};

const OUTCOMES: Outcome[] = [
  {
    name: "Worker 401 missing (the node holds no token)",
    script: () => workerReturns(401, { error: "missing", detail: "missing Authorization Bearer JWT" }),
    status: 401,
    body: { error: "auth_missing" },
  },
  {
    name: "Worker 401 expired (the node's token is invalid)",
    script: () => workerReturns(401, { error: "expired", detail: "JWT expired" }),
    status: 401,
    body: { error: "auth_invalid" },
  },
  {
    name: "Worker 403 scope_insufficient",
    script: () => workerReturns(403, { error: "scope_insufficient", detail: "endpoint requires scope=full; token has scope=payment" }),
    status: 403,
    body: { error: "scope_insufficient" },
  },
  {
    name: "Worker 503 with its own reason (service_unconfigured)",
    script: () => workerReturns(503, { error: "service_unconfigured", detail: "SUBSCRIPTION_PUBLIC_KEY is not configured on this Worker" }),
    status: 503,
    body: { error: "worker_unavailable", reason: "service_unconfigured" },
  },
  {
    name: "Worker 503 with its own reason (daybreak_read_failed)",
    script: () => workerReturns(503, { error: "daybreak_read_failed" }),
    status: 503,
    body: { error: "worker_unavailable", reason: "daybreak_read_failed" },
  },
  {
    name: "Worker other 5xx (500)",
    script: () => workerReturns(500, "Internal error"),
    status: 502,
    body: { error: "upstream_error", status: 500 },
  },
  {
    name: "network failure reaching the Worker",
    script: () => {
      workerState.next = { kind: "throw", reason: "transport_error", message: "Worker unreachable: getaddrinfo ENOTFOUND x" };
    },
    status: 503,
    body: { error: "worker_unreachable" },
  },
  {
    name: "COINBASE_WORKER_URL unset on this node",
    script: () => {
      workerState.next = { kind: "throw", reason: "not_configured", message: "COINBASE_WORKER_URL is not configured on this node" };
    },
    status: 503,
    body: { error: "worker_not_configured" },
  },
];

describe("test 31 — each Worker outcome maps to its OWN proxy reason", () => {
  for (const o of OUTCOMES) {
    it(`PERMITS: ${o.name} → ${o.status} ${JSON.stringify(o.body)}`, async () => {
      o.script();
      const out = await getEdition();
      expect(out.status).toBe(o.status);
      expect(out.body).toEqual(o.body);
    });
  }

  it("FORBIDS: no two distinct outcomes share one reason", async () => {
    const seen = new Map<string, string>();
    for (const o of OUTCOMES) {
      o.script();
      const out = await getEdition();
      const key = `${out.status} ${JSON.stringify(out.body)}`;
      expect(seen.has(key), `${o.name} shares its reason with ${seen.get(key)}`).toBe(false);
      seen.set(key, o.name);
    }
    expect(seen.size).toBe(OUTCOMES.length);
  });

  it("FORBIDS: the Worker's 503 reason is never dropped into a generic upstream code", async () => {
    workerReturns(503, { error: "service_unconfigured" });
    const out = await getEdition();
    expect(out.body.error).not.toBe("upstream_error");
    expect(out.body.reason).toBe("service_unconfigured");
  });

  it("the two 401s stay distinct from each other: missing vs bad_signature", async () => {
    workerReturns(401, { error: "missing" });
    const missing = (await getEdition()).body;
    workerReturns(401, { error: "bad_signature", detail: "JWT signature invalid" });
    const badSig = (await getEdition()).body;
    expect(missing).toEqual({ error: "auth_missing" });
    expect(badSig).toEqual({ error: "auth_invalid" });
  });

  it("a 503 whose reason is not a code (free text) is not relayed as a reason", async () => {
    workerReturns(503, { error: "KV key daybreak:2026-09-23:published is broken" });
    const out = await getEdition();
    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "upstream_error", status: 503 });
    expect(out.raw).not.toContain("daybreak:");
  });

  it("codes only: no Worker or transport free-text detail reaches any response body", async () => {
    const FREE_TEXT = [
      "missing Authorization Bearer JWT",
      "JWT expired",
      "endpoint requires scope=full",
      "SUBSCRIPTION_PUBLIC_KEY",
      "Internal error",
      "getaddrinfo",
      "COINBASE_WORKER_URL",
    ];
    for (const o of OUTCOMES) {
      o.script();
      const out = await getEdition();
      // Permitting companion in the same loop: each response IS the mapped one.
      // Without it an empty body (e.g. a 404 before the route existed) passes
      // the scan below vacuously — observed on the pre-change tree.
      expect(out.status).toBe(o.status);
      expect(out.body).toEqual(o.body);
      for (const s of FREE_TEXT) expect(out.raw, `${o.name} leaked "${s}"`).not.toContain(s);
    }
    // Anti-vacuity: the scripted Worker bodies really carried that text.
    workerReturns(401, { error: "expired", detail: "JWT expired" });
    expect(JSON.stringify(workerState.next)).toContain("JWT expired");
  });
});
