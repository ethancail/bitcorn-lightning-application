// Route-level tests for the Daybreak editor's three treasury API proxies — spec
// §3.4.5 (bitcorn-research specs/2026-09-21-bitcorn-daybreak-spec.md), first
// tests 77, 78, 79 and the proxy half of 72:
//
//   GET  /api/daybreak/editor          → Worker GET  /daybreak/editor
//   POST /api/daybreak/editor/save     → Worker POST /daybreak/editor/save
//   POST /api/daybreak/editor/publish  → Worker POST /daybreak/editor/publish
//
// Plus the codes-only property ("Codes kept, as the read path's proxy keeps
// them"): a Worker `detail`, free text, or a non-code `error` never reaches the
// response body.
//
// ⚠ NO NETWORK. Global fetch is replaced by a scripted spy. The routes are
// driven through the REAL handleRequest — the confirmation gate, the dispatch
// chain and its exact-URL matching are all live — so an unclassified route
// gets the real 400 and a query string really falls through.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough, Readable } from "stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at module scope.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-daybreak-editor-db-"));
process.env.DB_DIR = TMP_DB;

const roleState = vi.hoisted(() => ({ node: null as { node_role?: string } | null }));

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

const { handleRequest } = await import("../index");
const { ENV } = await import("../config/env");
const { classifyMutation, EXEMPT_MUTATIONS } = await import("../utils/action-confirmation");

const WORKER = "https://worker.test";
// Distinctive, so a leak is unambiguous when bodies and logs are scanned.
const SECRET = "editor-secret-Zq81xVb3-never-leaves-the-node";
// The proxy's cap. It must not be below the Worker's 32 KiB
// (EDITOR_BODY_MAX_BYTES, cloudflare-worker/src/handlers/daybreakEditor.ts).
const CAP = 32 * 1024;

const ROUTES = {
  read: { method: "GET", url: "/api/daybreak/editor", worker: "/daybreak/editor" },
  save: { method: "POST", url: "/api/daybreak/editor/save", worker: "/daybreak/editor/save" },
  publish: { method: "POST", url: "/api/daybreak/editor/publish", worker: "/daybreak/editor/publish" },
} as const;
type RouteName = keyof typeof ROUTES;
const ALL: RouteName[] = ["read", "save", "publish"];
const MUTATIONS: RouteName[] = ["save", "publish"];

// ─── The Worker double ─────────────────────────────────────────────────────

type Scripted = { kind: "response"; status: number; body: string } | { kind: "throw"; message: string };

let script: Scripted | null = null;
let workerCalls: Array<{ url: string; init: RequestInit }> = [];

function workerReturns(status: number, body: unknown) {
  script = { kind: "response", status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  // Only Worker-bound calls are the proxy's; anything else is not this test's.
  if (!url.startsWith(WORKER)) throw new Error(`unexpected fetch ${url}`);
  workerCalls.push({ url, init: init ?? {} });
  if (!script) throw new Error("test did not script the Worker");
  if (script.kind === "throw") throw new TypeError(script.message);
  return new Response(script.body, { status: script.status, headers: { "Content-Type": "application/json" } });
});

// ─── Request / response doubles ────────────────────────────────────────────

type Sent = { status: number | null; body: any; raw: string };

function makeRes(captured: { status: number | null; body: string }) {
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
  return res;
}

async function send(
  route: RouteName,
  opts: { body?: string | Buffer; url?: string; headers?: Record<string, string>; noContentType?: boolean; stream?: Readable; remoteAddress?: string } = {},
): Promise<Sent> {
  const r = ROUTES[route];
  const captured = { status: null as number | null, body: "" };
  const req = (opts.stream ?? new PassThrough()) as any;
  req.method = r.method;
  req.url = opts.url ?? r.url;
  // A POST carries application/json by default, as the web client sends it.
  const json = r.method === "POST" && !opts.noContentType ? { "content-type": "application/json" } : {};
  req.headers = { ...json, ...(opts.headers ?? {}) };
  req.socket = { remoteAddress: opts.remoteAddress ?? "100.64.0.7" };
  if (!opts.stream) {
    if (r.method === "GET") req.end();
    else req.end(opts.body ?? "");
  }
  await handleRequest(req, makeRes(captured));
  let body: any = null;
  try {
    body = JSON.parse(captured.body);
  } catch {
    body = null;
  }
  return { status: captured.status, body, raw: captured.body };
}

const SAVE_BODY = JSON.stringify({ date: "2026-10-07", sections: { lead: "Corn opened flat." } });
const PUBLISH_BODY = JSON.stringify({ date: "2026-10-07" });
const bodyFor = (route: RouteName) => (route === "save" ? SAVE_BODY : route === "publish" ? PUBLISH_BODY : undefined);

const READ_OK = {
  next: { date: "2026-10-07", published: false, code: "no_draft" },
  recent: { date: "2026-10-06", published: true, content: { lead: "Yesterday.", workerOwned: { z: { status: "unavailable", reason: "fetch_failed" } } } },
};
const SAVE_OK = { date: "2026-10-07", z: { status: "available" } };
const PUBLISH_OK = { date: "2026-10-07" };
const okFor = (route: RouteName) => (route === "read" ? READ_OK : route === "save" ? SAVE_OK : PUBLISH_OK);

let logged: string[] = [];
const savedEnv = { secret: undefined as unknown, url: "" };

beforeEach(() => {
  script = null;
  workerCalls = [];
  logged = [];
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  roleState.node = { node_role: "treasury" };
  savedEnv.secret = (ENV as any).daybreakEditorSecret;
  savedEnv.url = ENV.coinbaseWorkerUrl;
  (ENV as any).daybreakEditorSecret = SECRET;
  ENV.coinbaseWorkerUrl = WORKER;
  for (const level of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    });
  }
});

afterEach(() => {
  (ENV as any).daybreakEditorSecret = savedEnv.secret;
  ENV.coinbaseWorkerUrl = savedEnv.url;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

const headerMap = (init: RequestInit) => {
  const out: Record<string, string> = {};
  new Headers(init.headers as HeadersInit).forEach((v, k) => (out[k] = v));
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
// Test 77 — the proxies (R3, R5). The permitting control leads.
// ═══════════════════════════════════════════════════════════════════════════

describe("test 77: the proxies call the Worker with the ENV secret, on a treasury node only", () => {
  for (const route of ALL) {
    it(`PERMITS (${route}): a treasury node reaches the Worker with Authorization: Bearer <ENV secret> and relays the 200`, async () => {
      workerReturns(200, okFor(route));
      const out = await send(route, { body: bodyFor(route) });
      expect(out.status).toBe(200);
      expect(out.body).toEqual(okFor(route));
      expect(workerCalls).toHaveLength(1);
      expect(workerCalls[0].url).toBe(`${WORKER}${ROUTES[route].worker}`);
      expect(workerCalls[0].init.method).toBe(ROUTES[route].method);
      expect(headerMap(workerCalls[0].init).authorization).toBe(`Bearer ${SECRET}`);
    });
  }

  it("PERMITS: the save's and the publish's bodies reach the Worker byte-for-byte", async () => {
    for (const route of MUTATIONS) {
      workerReturns(200, okFor(route));
      workerCalls = [];
      await send(route, { body: bodyFor(route) });
      expect(Buffer.from(workerCalls[0].init.body as any).toString("utf8")).toBe(bodyFor(route));
    }
  });

  it("PERMITS: a trailing slash on the Worker URL does not double the path", async () => {
    ENV.coinbaseWorkerUrl = `${WORKER}/`;
    workerReturns(200, READ_OK);
    await send("read");
    expect(workerCalls[0].url).toBe(`${WORKER}/daybreak/editor`);
  });

  for (const route of ALL) {
    it(`FORBIDS (${route}): a member node, and a node with no role, are refused with a code and the Worker is NOT called`, async () => {
      for (const node of [{ node_role: "member" }, { node_role: "node" }, {}, null]) {
        roleState.node = node as any;
        workerReturns(200, okFor(route));
        const out = await send(route, { body: bodyFor(route) });
        expect(out.status, JSON.stringify(node)).toBe(403);
        expect(out.body).toEqual({ error: "treasury_role_required" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`FORBIDS (${route}): with the secret unset or empty, a code is returned and the Worker is NOT called`, async () => {
      for (const unset of [undefined, ""]) {
        (ENV as any).daybreakEditorSecret = unset;
        workerReturns(200, okFor(route));
        const out = await send(route, { body: bodyFor(route) });
        expect(out.status).toBe(503);
        expect(out.body).toEqual({ error: "editor_not_configured" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`FORBIDS (${route}): with the Worker URL unset, a code is returned and the Worker is NOT called`, async () => {
      ENV.coinbaseWorkerUrl = "";
      const out = await send(route, { body: bodyFor(route) });
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ error: "worker_not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("each Worker outcome keeps its own proxy code — auth, the Worker's 503 reason, other 5xx, a bad 200 and the network stay distinct", async () => {
    const cases: Array<[Scripted, number, unknown]> = [
      [{ kind: "response", status: 401, body: JSON.stringify({ error: "invalid_bearer" }) }, 502, { error: "worker_auth_rejected", reason: "invalid_bearer" }],
      [{ kind: "response", status: 503, body: JSON.stringify({ error: "daybreak_editor_not_configured" }) }, 503, { error: "worker_unavailable", reason: "daybreak_editor_not_configured" }],
      [{ kind: "response", status: 503, body: JSON.stringify({ error: "daybreak_editor_failed" }) }, 503, { error: "worker_unavailable", reason: "daybreak_editor_failed" }],
      [{ kind: "response", status: 500, body: "{}" }, 502, { error: "upstream_error", status: 500 }],
      [{ kind: "response", status: 200, body: "<html>not json</html>" }, 502, { error: "invalid_worker_response" }],
      [{ kind: "throw", message: "fetch failed" }, 503, { error: "worker_unreachable" }],
    ];
    const seen = new Set<string>();
    for (const [s, status, body] of cases) {
      script = s;
      const out = await send("read");
      expect(out.status, JSON.stringify(s)).toBe(status);
      expect(out.body, JSON.stringify(s)).toEqual(body);
      seen.add(JSON.stringify(out.body));
    }
    expect(seen.size, "no two distinct outcomes share a body").toBe(cases.length);
  });

  it("the Worker's refusal codes pass through under editor_refused, with their status and a field NAME", async () => {
    const cases: Array<[RouteName, number, unknown, unknown]> = [
      ["save", 400, { error: "invalid_link", field: "worthReading.link" }, { error: "editor_refused", reason: "invalid_link", field: "worthReading.link" }],
      ["save", 400, { error: "unknown_section", field: "workerOwned" }, { error: "editor_refused", reason: "unknown_section", field: "workerOwned" }],
      ["save", 422, { error: "not_editable_date" }, { error: "editor_refused", reason: "not_editable_date" }],
      ["save", 413, { error: "body_too_large" }, { error: "editor_refused", reason: "body_too_large" }],
      ["publish", 409, { error: "nothing_to_publish" }, { error: "editor_refused", reason: "nothing_to_publish" }],
    ];
    for (const [route, status, worker, expected] of cases) {
      workerReturns(status, worker);
      const out = await send(route, { body: bodyFor(route) });
      expect(out.status, JSON.stringify(worker)).toBe(status);
      expect(out.body).toEqual(expected);
    }
  });

  it("FORBIDS: the secret appears in NO response body and NO log line, across every outcome", async () => {
    const bodies: string[] = [];
    const scripts: Scripted[] = [
      { kind: "response", status: 200, body: JSON.stringify(READ_OK) },
      { kind: "response", status: 401, body: JSON.stringify({ error: "invalid_bearer", detail: "bearer did not match" }) },
      { kind: "response", status: 503, body: JSON.stringify({ error: "daybreak_editor_failed" }) },
      { kind: "response", status: 500, body: "oops" },
      { kind: "response", status: 200, body: "not json" },
      { kind: "throw", message: "connect ECONNREFUSED" },
    ];
    for (const s of scripts) {
      for (const route of ALL) {
        script = s;
        bodies.push((await send(route, { body: bodyFor(route) })).raw);
      }
    }
    (ENV as any).daybreakEditorSecret = "";
    bodies.push((await send("save", { body: SAVE_BODY })).raw);

    expect(bodies.length).toBeGreaterThan(10);
    expect(logged.length, "anti-vacuity: the failures above DO log").toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain(SECRET);
    for (const l of logged) expect(l).not.toContain(SECRET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codes only — the proxy relays codes, never detail or free text.
// ═══════════════════════════════════════════════════════════════════════════

describe("codes only: no Worker detail, free text or non-code value reaches the response", () => {
  it("PERMITS: a code-shaped refusal passes through (the control for the forbidding cases)", async () => {
    workerReturns(422, { error: "not_editable_date" });
    const out = await send("save", { body: SAVE_BODY });
    expect(out.body).toEqual({ error: "editor_refused", reason: "not_editable_date" });
  });

  it("FORBIDS: a Worker `detail` is dropped from every kind of failure, and goes to the log instead", async () => {
    const DETAIL = "KV get daybreak:2026-10-07:working threw: quota exceeded";
    for (const [status, error] of [[400, "invalid_link"], [401, "invalid_bearer"], [422, "not_editable_date"], [503, "daybreak_editor_failed"], [500, "boom"]] as const) {
      workerReturns(status, { error, detail: DETAIL, field: "worthReading.link" });
      const out = await send("save", { body: SAVE_BODY });
      expect(out.raw, `${status}`).not.toContain(DETAIL);
      expect(out.raw).not.toContain("daybreak:");
      expect(Object.keys(out.body).sort().every((k) => ["error", "reason", "field", "status"].includes(k)), out.raw).toBe(true);
    }
    expect(logged.some((l) => l.includes(DETAIL)), "anti-vacuity: the detail was really there, and was logged").toBe(true);
  });

  it("FORBIDS: free text in the Worker's `error` is not relayed — it becomes upstream_error with the status", async () => {
    for (const status of [400, 409, 422, 503]) {
      workerReturns(status, { error: "Something broke while saving Kevin's edition" });
      const out = await send("save", { body: SAVE_BODY });
      expect(out.body, `${status}`).toEqual({ error: "upstream_error", status });
      expect(out.raw).not.toContain("Something broke");
    }
  });

  it("FORBIDS: a field that is not a field NAME is dropped, the code is kept", async () => {
    workerReturns(400, { error: "unknown_section", field: "a key with spaces <and markup>" });
    const out = await send("save", { body: SAVE_BODY });
    expect(out.body).toEqual({ error: "editor_refused", reason: "unknown_section" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 78 — classified exempt; exact match (R5).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 78: each editor mutation is classified exempt, and only the exact path matches", () => {
  it("PERMITS: each editor mutation has its own exact exempt entry, citing that no money moves", () => {
    for (const route of MUTATIONS) {
      const { method, url } = ROUTES[route];
      expect(classifyMutation(method, url), url).toBe("exempt");
      const entry = EXEMPT_MUTATIONS.find((e) => e.method === method && e.match.kind === "exact" && (e.match as any).url === url);
      expect(entry, `${url} needs an EXACT entry`).toBeDefined();
      expect(entry!.why).toMatch(/no money moves/);
    }
  });

  it("PERMITS: the exempt save is dispatched — not refused by the gate", async () => {
    workerReturns(200, SAVE_OK);
    const out = await send("save", { body: SAVE_BODY });
    expect(out.status).toBe(200);
  });

  it("FORBIDS: the exact path with ?x=1 appended — a GET gets 404, a POST gets 400 confirmation_required, the Worker is never called", async () => {
    workerReturns(200, READ_OK);
    const read = await send("read", { url: "/api/daybreak/editor?x=1" });
    expect(read.status).toBe(404);
    for (const route of MUTATIONS) {
      const out = await send(route, { url: `${ROUTES[route].url}?x=1`, body: bodyFor(route) });
      expect(out.status, route).toBe(400);
      expect(out.body.error).toBe("confirmation_required");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 79 — the proxy's body cap (R5).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 79: the proxy caps the body itself", () => {
  // A conforming save body padded to exactly `n` bytes.
  const saveOfSize = (n: number) => {
    const shell = JSON.stringify({ date: "2026-10-07", sections: { lead: "" } });
    return JSON.stringify({ date: "2026-10-07", sections: { lead: "x".repeat(n - shell.length) } });
  };

  it("the proxy's cap is not below the Worker's 32 KiB", async () => {
    const mod: any = await import("./editorProxy");
    expect(mod.EDITOR_PROXY_BODY_MAX_BYTES).toBeGreaterThanOrEqual(CAP);
  });

  for (const route of MUTATIONS) {
    it(`PERMITS (${route}): a body exactly at the cap is forwarded whole`, async () => {
      const body = saveOfSize(CAP);
      expect(Buffer.byteLength(body)).toBe(CAP);
      workerReturns(200, okFor(route));
      const out = await send(route, { body });
      expect(out.status).toBe(200);
      expect(Buffer.from(workerCalls[0].init.body as any).toString("utf8")).toBe(body);
    });

    it(`FORBIDS (${route}): one byte over the cap gets 413 body_too_large and the Worker is NOT called`, async () => {
      workerReturns(200, okFor(route));
      const out = await send(route, { body: saveOfSize(CAP + 1) });
      expect(out.status).toBe(413);
      expect(out.body).toEqual({ error: "body_too_large" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`FORBIDS (${route}): a declared Content-Length over the cap is refused UNREAD`, async () => {
      let touched = false;
      const stream = new Readable({
        read() {
          touched = true;
          this.destroy(new Error("this body must never be read"));
        },
      });
      workerReturns(200, okFor(route));
      const out = await send(route, { stream, headers: { "content-length": String(CAP + 1) } });
      expect(out.status).toBe(413);
      expect(out.body).toEqual({ error: "body_too_large" });
      expect(touched, "the stream was read").toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CSRF hardening — save and publish accept ONLY a JSON POST.
// ═══════════════════════════════════════════════════════════════════════════

describe("CSRF hardening: save and publish require Content-Type: application/json", () => {
  // A body stream that records whether anything read it.
  const watched = (payload: string) => {
    const state = { touched: false };
    const stream = new Readable({
      read() {
        state.touched = true;
        this.push(payload);
        this.push(null);
      },
    });
    return { stream, state };
  };

  for (const route of MUTATIONS) {
    it(`PERMITS (${route}): an application/json POST is accepted — with or without a charset`, async () => {
      for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
        workerReturns(200, okFor(route));
        workerCalls = [];
        const { stream, state } = watched(bodyFor(route)!);
        const out = await send(route, { stream, headers: { "content-type": type } });
        expect(out.status, type).toBe(200);
        expect(state.touched, "anti-vacuity: an accepted body IS read").toBe(true);
        expect(workerCalls, type).toHaveLength(1);
      }
    });

    for (const [what, headers] of [
      ["text/plain", { "content-type": "text/plain" }],
      ["text/plain with a charset", { "content-type": "text/plain;charset=UTF-8" }],
      ["a form encoding", { "content-type": "application/x-www-form-urlencoded" }],
      ["multipart", { "content-type": "multipart/form-data; boundary=x" }],
      ["a missing content type", null],
    ] as const) {
      it(`FORBIDS (${route}): ${what} is refused with 415 unsupported_content_type; the body is never read and the Worker is not called`, async () => {
        workerReturns(200, okFor(route));
        const { stream, state } = watched(bodyFor(route)!);
        const out = await send(route, headers ? { stream, headers } : { stream, noContentType: true });
        expect(out.status).toBe(415);
        expect(out.body).toEqual({ error: "unsupported_content_type" });
        expect(state.touched, "the body was read").toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
  }

  it("the read, a GET with no body, needs no content type", async () => {
    workerReturns(200, READ_OK);
    const out = await send("read");
    expect(out.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 72, the proxy half — no author (R1).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 72 (proxy half): no caller-identifying header is forwarded", () => {
  const CALLER = {
    "user-agent": "Mozilla/5.0 (iPhone; Kevin's phone)",
    "x-forwarded-for": "100.64.0.9",
    "x-real-ip": "100.64.0.9",
    cookie: "session=abc",
    authorization: "Bearer something-the-browser-sent",
    referer: "http://treasury.tail/daybreak-editor",
    origin: "http://treasury.tail",
  };

  it("PERMITS: the Worker receives the Authorization the proxy built and the content type", async () => {
    workerReturns(200, SAVE_OK);
    await send("save", { body: SAVE_BODY, headers: { ...CALLER, "content-type": "application/json" } });
    const h = headerMap(workerCalls[0].init);
    expect(h.authorization).toBe(`Bearer ${SECRET}`);
    expect(h["content-type"]).toBe("application/json");
  });

  for (const route of ALL) {
    it(`FORBIDS (${route}): the forwarded headers are EXACTLY the proxy's own — nothing from the caller`, async () => {
      workerReturns(200, okFor(route));
      await send(route, { body: bodyFor(route), headers: { ...CALLER, "content-type": "application/json" } });
      const h = headerMap(workerCalls[0].init);
      const expected = route === "read" ? ["authorization"] : ["authorization", "content-type"];
      expect(Object.keys(h).sort()).toEqual(expected);
      for (const v of Object.values(CALLER)) expect(Object.values(h)).not.toContain(v);
    });
  }

  it("ANTI-VACUITY: two callers with different addresses and User-Agents produce byte-identical Worker requests", async () => {
    const forwarded: string[] = [];
    for (const [ua, ip] of [["Kevin's phone", "100.64.0.9"], ["A desktop browser", "192.168.1.20"]]) {
      workerReturns(200, SAVE_OK);
      workerCalls = [];
      await send("save", { body: SAVE_BODY, headers: { "user-agent": ua, "x-forwarded-for": ip }, remoteAddress: ip });
      const c = workerCalls[0];
      forwarded.push(JSON.stringify([c.url, c.init.method, headerMap(c.init), Buffer.from(c.init.body as any).toString("base64")]));
    }
    expect(forwarded[0]).toBe(forwarded[1]);
  });
});
