// The cross-site mutation guard in handleRequest, driven through the real
// exported handler.
//
// THE HOLE THIS PINS: CORS stops a page reading the reply, not the request
// running. A browser sends a POST typed text/plain, form-encoded, multipart or
// untyped WITHOUT a preflight, and the handlers JSON.parse the body whatever its
// type. Routes exempt from per-action confirmation therefore ran for any page on
// any site — including three that move funds and need no body at all.
//
// "THE HANDLER NEVER RAN" is measured, not inferred, two ways:
//   · classifyMutation is the only road from handleRequest to dispatch for a
//     mutation, and the probe below counts its calls. Zero calls = no dispatch.
//     The permitting rows prove the probe can see a call.
//   · the three capital routes' own primitives are counted directly.
//
// RED FIRST: run against the pre-change index.ts, every forbidding row here
// failed (see the commit message for the recorded counts).

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import ts from "typescript";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-cross-site-test-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");

const probe = vi.hoisted(() => ({
  classify: 0,
  /** When set, classification answers "unknown" so the gate refuses and no handler runs. */
  stopAtGate: false,
  payFromNode: 0,
  autobuyTick: 0,
  autoLoopOut: 0,
}));

vi.mock("./utils/action-confirmation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/action-confirmation")>();
  return {
    ...actual,
    classifyMutation: (method: string, url: string) => {
      probe.classify++;
      return probe.stopAtGate ? "unknown" : actual.classifyMutation(method, url);
    },
  };
});

// The three capital routes' primitives, counted. Role checks are lifted so the
// permitting controls reach the primitive on a temp DB with no node row.
vi.mock("./utils/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/role")>()),
  assertTreasury: () => {},
  assertMember: () => {},
  assertNonEmpty: () => {},
}));
vi.mock("./subscription/payFromNode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscription/payFromNode")>()),
  executePayFromNode: async () => {
    probe.payFromNode++;
    return { ok: true, txid: "probe" };
  },
}));
vi.mock("./autoBuy/scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./autoBuy/scheduler")>()),
  runTick: async () => {
    probe.autobuyTick++;
  },
}));
vi.mock("./lightning/rebalance-loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/rebalance-loop")>()),
  autoLoopOutRebalance: async () => {
    probe.autoLoopOut++;
    return { ok: true };
  },
}));
vi.mock("./lightning/loop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/loop")>()),
  isLoopAvailable: async () => ({ available: true }),
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: import("better-sqlite3").Database;
let tables: typeof import("./utils/action-confirmation");

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("./index"));
  const { runMigrations } = await import("./db/migrate");
  runMigrations();
  ({ db } = await import("./db"));
  tables = await import("./utils/action-confirmation");
});

beforeEach(() => {
  probe.classify = 0;
  probe.stopAtGate = false;
  probe.payFromNode = 0;
  probe.autobuyTick = 0;
  probe.autoLoopOut = 0;
  db.prepare("DELETE FROM contacts").run();
});

type Captured = { status: number; body: any; bodyRead: boolean };

/** Drive handleRequest with exactly these headers; report whether the body stream was touched. */
function call(
  method: string,
  url: string,
  headers: Record<string, string>,
  rawBody = ""
): Promise<Captured> {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = headers;
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let parsed: any = null;
      try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
      // A handler that read the body attached a data listener or put the stream
      // into flowing mode; one that never looked left it paused (null).
      const bodyRead = stream.listenerCount("data") > 0 || stream.readableFlowing !== null;
      resolve({ status, body: parsed, bodyRead });
    };
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(s: number) { status = s; return res; },
      end(c?: any) { if (c) chunks += c.toString(); finish(); },
      write(c: any) { if (c) chunks += c.toString(); return true; },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => stream.end(rawBody));
    setTimeout(() => { if (!done) { status = -1; finish(); } }, 4000);
  });
}

// ─── EVERY mutation dispatchRequest serves ──────────────────────────────────
// Enumerated from index.ts's dispatch chain with the same scan the AST coverage
// test uses (method literal + req.url ===/startsWith/endsWith), then checked
// against the classification tables so an empty or drifted scan cannot pass.

type Mutation = { method: string; url: string; key: string };

function enumerateMutations(): Mutation[] {
  const file = path.join(__dirname, "index.ts");
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const dispatch = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "dispatchRequest"
  );
  if (!dispatch) throw new Error("dispatchRequest not found in index.ts");

  const out: Mutation[] = [];
  for (const stmt of dispatch.body?.statements ?? []) {
    if (!ts.isIfStatement(stmt)) continue;
    let method: string | null = null;
    const exacts: string[] = [];
    let prefix: string | null = null;
    let suffix: string | null = null;
    const scan = (e: ts.Node): void => {
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const lhs = e.left.getText().replace(/[?]/g, "");
        if (lhs === "req.method" && ts.isStringLiteral(e.right)) method = e.right.text;
        if (lhs === "req.url" && ts.isStringLiteral(e.right)) exacts.push(e.right.text);
      }
      if (ts.isCallExpression(e)) {
        const callee = e.expression.getText().replace(/[?]/g, "");
        const arg = e.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (callee === "req.url.startsWith") prefix = arg.text;
          if (callee === "req.url.endsWith") suffix = arg.text;
        }
      }
      ts.forEachChild(e, scan);
    };
    scan(stmt.expression);
    if (!method || method === "GET" || method === "HEAD" || method === "OPTIONS") continue;

    // A concrete URL each matcher accepts; the key mirrors the table's matcher.
    if (prefix && suffix) out.push({ method, url: `${prefix}1${suffix}`, key: `${method} ^${prefix}$${suffix}` });
    else if (prefix) out.push({ method, url: `${prefix}1`, key: `${method} ^${prefix}` });
    for (const u of exacts) out.push({ method, url: u, key: `${method} =${u}` });
  }
  return out;
}

const MUTATIONS = enumerateMutations();

const tableKey = (method: string, m: import("./utils/action-confirmation").Matcher) =>
  m.kind === "exact" ? `${method} =${m.url}` : m.kind === "prefix" ? `${method} ^${m.url}` : `${method} ^${m.prefix}$${m.suffix}`;

describe("the enumeration is the full mutation set", () => {
  it("matches CONFIRMED_ROUTES + EXEMPT_MUTATIONS exactly", () => {
    const declared = [
      ...tables.CONFIRMED_ROUTES.map((r) => tableKey(r.method, r.match)),
      ...tables.EXEMPT_MUTATIONS.map((e) => tableKey(e.method, e.match)),
    ].sort();
    expect(MUTATIONS.map((m) => m.key).sort()).toEqual(declared);
    expect(MUTATIONS.length).toBeGreaterThan(40);
  });
});

// The four shapes a cross-site page can send without a preflight.
const SIMPLE_SHAPES: Array<[label: string, headers: Record<string, string>, body: string]> = [
  ["text/plain", { "content-type": "text/plain;charset=UTF-8" }, '{"enabled":true}'],
  ["form-encoded", { "content-type": "application/x-www-form-urlencoded" }, "enabled=true"],
  ["multipart", { "content-type": "multipart/form-data; boundary=x" }, '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n'],
  ["no Content-Type", {}, ""],
];

describe.each(MUTATIONS.map((m) => [m.key, m] as const))("%s", (_key, m) => {
  it.each(SIMPLE_SHAPES)("refuses %s with 415, before dispatch, body unread", async (_label, headers, body) => {
    const r = await call(m.method, m.url, headers, body);
    expect(r.status).toBe(415);
    expect(r.body).toEqual({ error: "unsupported_content_type" });
    expect(probe.classify, "reached classification — the handler could have run").toBe(0);
    expect(r.bodyRead).toBe(false);
  });

  it("lets application/json through to classification, any case, with charset (permitting control)", async () => {
    probe.stopAtGate = true;
    const r = await call(m.method, m.url, { "content-type": "Application/JSON; charset=utf-8" }, "{}");
    expect(probe.classify).toBe(1);
    expect(r.body?.error).toBe("confirmation_required");
  });
});

describe("unclassified mutations go through the guard too", () => {
  it("a POST to no route, text/plain → 415 before classification", async () => {
    const r = await call("POST", "/api/not-a-route", { "content-type": "text/plain" }, "{}");
    expect(r.status).toBe(415);
    expect(probe.classify).toBe(0);
  });
  it("a PUT (no route uses it), no Content-Type → 415", async () => {
    const r = await call("PUT", "/api/contacts", {});
    expect(r.status).toBe(415);
    expect(probe.classify).toBe(0);
  });
});

// ─── The three bodiless capital routes, by name ─────────────────────────────
// Each moves funds, takes no parameter, and is exempt from confirmation — so
// before this guard a bodiless text/plain POST from any site ran it.
const CAPITAL: Array<[url: string, counter: "payFromNode" | "autobuyTick" | "autoLoopOut"]> = [
  ["/api/subscription/pay-from-node", "payFromNode"],
  ["/api/autobuy/execute-now", "autobuyTick"],
  ["/api/treasury/rebalance/loop-out/auto", "autoLoopOut"],
];

describe.each(CAPITAL)("POST %s", (url, counter) => {
  it("bodiless text/plain is refused and the primitive never runs", async () => {
    const r = await call("POST", url, { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    expect(r.body).toEqual({ error: "unsupported_content_type" });
    expect(probe[counter]).toBe(0);
  });

  it("bodiless with no Content-Type is refused and the primitive never runs", async () => {
    const r = await call("POST", url, {});
    expect(r.status).toBe(415);
    expect(probe[counter]).toBe(0);
  });

  it("bodiless application/json reaches the primitive (permitting control: the counter can see a run)", async () => {
    const r = await call("POST", url, { "content-type": "application/json" });
    expect(r.status).toBe(200);
    expect(probe[counter]).toBe(1);
  });
});

// ─── Origin ─────────────────────────────────────────────────────────────────

const contactBody = JSON.stringify({ pubkey: "02" + "ab".repeat(32), name: "probe" });
const contactCount = () => (db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;

describe("a present non-private Origin is refused, even with JSON", () => {
  it.each([
    ["public name", "https://example.com"],
    ["spoofed private prefix", "http://10.attacker.example"],
    ["public IPv4", "http://8.8.8.8:3200"],
    ["opaque origin", "null"],
  ])("%s → 403 cross_site_refused, nothing written", async (_label, origin) => {
    const r = await call("POST", "/api/contacts", { origin, "content-type": "application/json" }, contactBody);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "cross_site_refused" });
    expect(probe.classify).toBe(0);
    expect(r.bodyRead).toBe(false);
    expect(contactCount()).toBe(0);
  });
});

describe("legitimate callers pass", () => {
  it.each([
    ["Umbrel mDNS", "http://umbrel.local:3200"],
    ["tailnet IP", "http://100.64.0.1:3200"],
    ["dev server", "http://localhost:5173"],
  ])("private Origin (%s) + JSON → the handler runs", async (_label, origin) => {
    const r = await call("POST", "/api/contacts", { origin, "content-type": "application/json" }, contactBody);
    expect(r.status).toBe(200);
    expect(contactCount()).toBe(1);
  });

  it("no Origin + JSON (server-to-server, curl) → the handler runs", async () => {
    const r = await call("POST", "/api/contacts", { "content-type": "application/json" }, contactBody);
    expect(r.status).toBe(200);
    expect(contactCount()).toBe(1);
  });

  it("a bodiless POST carrying JSON Content-Type, as the web app sends, reaches its handler", async () => {
    // /api/admin/swaps/loop-in answers 410 from its own handler, with no side effect.
    const r = await call("POST", "/api/admin/swaps/loop-in", {
      origin: "http://umbrel.local:3200",
      "content-type": "application/json",
    });
    expect(r.status).toBe(410);
    expect(r.body?.error).toBe("treasury_loop_in_deprecated");
  });
});
