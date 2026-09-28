// Router-level tests for the Radar write route, POST /daybreak/draft — spec
// §3.4.4, first tests 47, 48 and 50–56 (bitcorn-research, specs/2026-09-21-
// bitcorn-daybreak-spec.md). Test 49 (the next due date itself) is in
// tests/daybreak/dates.test.ts; the validator's unit halves of 51–52 are in
// tests/daybreak/sections.test.ts. Each test has a PERMITTING and a FORBIDDING
// case, and every "nothing happened" rides with a companion showing the same
// observation could have seen it happen (§5.1, §5.2).
//
// Everything goes through `worker.fetch`, so the router's dispatch is in the
// path. Codes, the field names and the env var are string LITERALS on purpose:
// they are the contract Radar is built against, and a rename must fail here.
//
// TIME. The route reads the real clock, so each test pins it (Date only, as in
// daybreakRoute.test.ts). THE PINNED INSTANT: Sunday 2026-09-27, 22:00 CDT
// (2026-09-28T03:00Z) — Radar's scheduled run (Ruling 3). The next due date is
// Monday 2026-09-28, and Sunday's own date is the {{isoDate}} trap.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import { DRAFT_BODY_MAX_BYTES } from "../src/handlers/daybreakDraft";
import { FAIL_CLOSED_FETCHER } from "../src/daybreak/failClosedFetcher";
import { POWER_LAW_PARAMS_KV_KEY } from "../src/valuation/powerLawParams";
import { ORACLE_PARAMS } from "./fixtures/daybreakPowerLawOracle";
import { createEntitlementSigner, withAuth, type EntitlementSigner } from "./helpers/entitlementToken";

const NOW = new Date("2026-09-28T03:00:00Z"); // Sun 2026-09-27 22:00 CDT
const NEXT_DUE = "2026-09-28";
const DRAFT_KEY = `daybreak:${NEXT_DUE}:draft`;
const ROUTE = "https://w/daybreak/draft";

const SECRET = "radar-test-secret-0123456789abcdef";
const WRONG = `${SECRET.slice(0, -1)}e`; // same length, differs in its last character only

let signer: EntitlementSigner;

beforeAll(async () => {
  signer = await createEntitlementSigner();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Op = { op: "get" | "put" | "delete"; key: string };

/** A KV double that records every key touched, and can be told to throw on put. */
function mockKV(opts: { seed?: Record<string, string>; throwOnPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const ops: Op[] = [];
  const kv = {
    async get(key: string) {
      ops.push({ op: "get", key });
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      ops.push({ op: "put", key });
      if (opts.throwOnPut) throw new Error(`KV PUT failed for ${key}`);
      store.set(key, value);
    },
    async delete(key: string) {
      ops.push({ op: "delete", key });
      store.delete(key);
    },
  } as unknown as KVNamespace;
  const puts = () => ops.filter((o) => o.op === "put").map((o) => o.key);
  return { kv, store, ops, puts };
}

const withParams = (opts: { throwOnPut?: boolean } = {}) =>
  mockKV({ ...opts, seed: { [POWER_LAW_PARAMS_KV_KEY]: JSON.stringify(ORACLE_PARAMS) } });

function envWith(kv: KVNamespace, overrides: Record<string, unknown> = {}): Env {
  return {
    PRICES_CACHE: kv,
    DAYBREAK_DRAFT_SECRET: SECRET,
    SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX,
    ...overrides,
  } as unknown as Env;
}

/** Exactly the five contract keys, each in its contract shape (§3.4.3). */
const SECTIONS = {
  lead: "Corn opened flat; the ratio did not.",
  kevinsRead: "First paragraph.\n\nSecond paragraph.",
  insideAgriculture: "A grain buyer in central Iowa said basis is widening.",
  worthReading: { title: "A report worth your time", note: "Why it matters.", link: "https://example.com/report" },
  closer: "Stack sats, plant corn.",
};

const envelope = (patch: Record<string, unknown> = {}) => ({ date: NEXT_DUE, sections: SECTIONS, ...patch });

type Body = string | ReadableStream<Uint8Array> | Record<string, unknown>;

function request(body: Body, authorization: string | null = `Bearer ${SECRET}`, headers: Record<string, string> = {}): Request {
  const h = new Headers({ "Content-Type": "application/json", ...headers });
  if (authorization !== null) h.set("Authorization", authorization);
  const payload = typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body);
  return new Request(ROUTE, { method: "POST", headers: h, body: payload });
}

function send(env: Env, req: Request): Promise<Response> {
  return worker.fetch(req, env, {} as any);
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A body stream that RECORDS whether anything read it. highWaterMark 0 stops
 * the stream pulling on construction, so `pulled` turns true only when a
 * consumer actually reads.
 */
function recordingBody(text: string) {
  const state = { pulled: false };
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function storedDraft(store: Map<string, string>, key = DRAFT_KEY): Record<string, unknown> {
  const raw = store.get(key);
  expect(raw, `${key} must have been written`).toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}

// ─── Configuration ───────────────────────────────────────────────────────

describe("an unset secret is 503, like the JWT routes' unset key", () => {
  it("permitting: with the secret configured, the write is accepted", async () => {
    const { kv, puts } = withParams();
    const res = await send(envWith(kv), request(envelope()));
    expect(res.status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: absent or empty, it is 503 with a code — nothing is read or written", async () => {
    for (const unset of [undefined, ""]) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv, { DAYBREAK_DRAFT_SECRET: unset }), request(envelope()));
      expect(res.status).toBe(503);
      expect(await jsonOf(res)).toEqual({ error: "daybreak_draft_not_configured" });
      expect(ops).toEqual([]);
    }
  });
});

// ─── Test 47 ─────────────────────────────────────────────────────────────

describe("test 47: the bearer", () => {
  it("permitting: the correct secret is accepted and the draft is written", async () => {
    const { kv, puts } = withParams();
    const res = await send(envWith(kv), request(envelope()));
    expect(res.status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: a wrong secret (same length, last character differs) is 401 — nothing is read or written", async () => {
    expect(WRONG).toHaveLength(SECRET.length);
    expect(WRONG.slice(0, -1)).toBe(SECRET.slice(0, -1));
    expect(WRONG).not.toBe(SECRET);
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request(envelope(), `Bearer ${WRONG}`));
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "invalid_bearer" });
    expect(ops).toEqual([]);
  });

  it("forbidding: an absent header, an empty value, and a non-Bearer form are 401 missing_bearer — nothing is read or written", async () => {
    for (const auth of [null, "", "Bearer ", "Bearer", `Basic ${SECRET}`, SECRET]) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(envelope(), auth));
      expect(res.status, String(auth)).toBe(401);
      expect(await jsonOf(res), String(auth)).toEqual({ error: "missing_bearer" });
      expect(ops, String(auth)).toEqual([]);
    }
  });

  it("anti-vacuity: the SAME request with the correct secret does write", async () => {
    const { kv, puts } = withParams();
    expect((await send(envWith(kv), request(envelope(), `Bearer ${WRONG}`))).status).toBe(401);
    expect(puts()).toEqual([]);
    expect((await send(envWith(kv), request(envelope(), `Bearer ${SECRET}`))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });
});

describe("the bearer comparison is constant-time (test 47's review property, made observable)", () => {
  // The route must compare through the runtime's constant-time primitive, on
  // equal-length SHA-256 digests — never `===` on the strings, and never on
  // inputs whose lengths differ (timingSafeEqual would throw, and a length
  // check first leaks the secret's length). The spy keeps the real
  // implementation; it only records the call.
  it("every presented bearer — right, wrong, or a different length — is compared by crypto.subtle.timingSafeEqual on two 32-byte digests", async () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const { kv } = withParams();
    const cases: Array<[string, number]> = [
      [SECRET, 200],
      [WRONG, 401],
      ["x", 401],
      [`${SECRET}-and-a-much-longer-suffix`, 401],
    ];
    for (const [bearer, status] of cases) {
      expect((await send(envWith(kv), request(envelope(), `Bearer ${bearer}`))).status, bearer).toBe(status);
    }
    expect(spy).toHaveBeenCalledTimes(cases.length);
    for (const [a, b] of spy.mock.calls) {
      expect((a as ArrayBuffer).byteLength).toBe(32);
      expect((b as ArrayBuffer).byteLength).toBe(32);
    }
    expect(spy.mock.results.map((r) => r.value)).toEqual([true, false, false, false]);
  });
});

// ─── Test 48 ─────────────────────────────────────────────────────────────

describe("test 48: only the next due date", () => {
  it("permitting: a write stating the next due date is accepted", async () => {
    const { kv, puts } = withParams();
    const res = await send(envWith(kv), request(envelope({ date: NEXT_DUE })));
    expect(res.status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: a valid date that is not the next due date is 422 not_next_due_date — nothing is read or written", async () => {
    const cases: Array<[string, string]> = [
      ["2026-09-25", "a due date whose 6:00 AM has passed (Friday)"],
      ["2026-09-29", "the due date AFTER the next one"],
      ["2026-09-27", "the run's own date — the {{isoDate}} trap"],
      ["2026-09-01", "a past date"],
      ["2026-10-03", "a non-due Saturday"],
    ];
    for (const [date, why] of cases) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(envelope({ date })));
      expect(res.status, why).toBe(422);
      expect(await jsonOf(res), why).toEqual({ error: "not_next_due_date" });
      expect(ops, why).toEqual([]);
    }
  });

  it("forbidding: a malformed or absent date is 400 invalid_date — nothing is read or written", async () => {
    const bad: unknown[] = ["2026-9-28", "2026-02-30", "28/09/2026", "2026-09-28T00:00:00Z", 20260928, null];
    for (const date of bad) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(envelope({ date })));
      expect(res.status, String(date)).toBe(400);
      expect(await jsonOf(res), String(date)).toEqual({ error: "invalid_date" });
      expect(ops, String(date)).toEqual([]);
    }
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request({ sections: SECTIONS }));
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "invalid_date" });
    expect(ops).toEqual([]);
  });

  it("at the route, 6:00:00 AM Central counts as PASSED (Ruling 4), and 5:59:59 does not", async () => {
    vi.setSystemTime(new Date("2026-09-28T10:59:59Z")); // Mon 05:59:59 CDT
    let m = withParams();
    expect((await send(envWith(m.kv), request(envelope({ date: "2026-09-28" })))).status).toBe(200);

    vi.setSystemTime(new Date("2026-09-28T11:00:00Z")); // Mon 06:00:00 CDT
    m = withParams();
    const late = await send(envWith(m.kv), request(envelope({ date: "2026-09-28" })));
    expect(late.status).toBe(422);
    expect(await jsonOf(late)).toEqual({ error: "not_next_due_date" });
    expect(m.ops).toEqual([]);
    m = withParams();
    expect((await send(envWith(m.kv), request(envelope({ date: "2026-09-29" })))).status).toBe(200);
    expect(m.puts()).toEqual(["daybreak:2026-09-29:draft"]);
  });
});

// ─── Test 50 ─────────────────────────────────────────────────────────────

describe("test 50: a write can only ever create a draft", () => {
  it("permitting: an accepted write lands at daybreak:<date>:draft, carrying the Worker-stamped Z", async () => {
    const { kv, store, puts } = withParams();
    expect((await send(envWith(kv), request(envelope()))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
    const owned = storedDraft(store).workerOwned as Record<string, unknown>;
    expect((owned.z as Record<string, unknown>).status).toBe("unavailable");
  });

  it("forbidding: no accepted or rejected write touches :published or :working, whatever the payload asks for", async () => {
    const { kv, ops } = withParams();
    const env = envWith(kv);
    const attempts: Array<[Body, number]> = [
      [envelope(), 200],
      [envelope({ slot: "published" }), 400],
      [envelope({ publish: true }), 400],
      [envelope({ sections: { ...SECTIONS, workerOwned: { z: { status: "available", value: 9 } } } }), 400],
      [envelope({ sections: { ...SECTIONS, published: true } }), 400],
      [envelope({ date: "2026-09-29" }), 422],
    ];
    for (const [body, status] of attempts) {
      expect((await send(env, request(body))).status, JSON.stringify(body)).toBe(status);
    }
    const touched = ops.map((o) => o.key);
    expect(touched.filter((k) => k.endsWith(":published") || k.endsWith(":working"))).toEqual([]);
    // anti-vacuity: the log did see an edition key — the draft
    expect(touched).toContain(DRAFT_KEY);
    expect(ops.filter((o) => o.op === "put").map((o) => o.key)).toEqual([DRAFT_KEY]);
  });
});

// ─── Test 51 (route level) ───────────────────────────────────────────────

describe("test 51: sections are validated — a 400 whose code names the field, and nothing written", () => {
  it("permitting: exactly the five contract keys, in their contract shapes, are accepted", async () => {
    const { kv, puts } = withParams();
    expect((await send(envWith(kv), request(envelope()))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: an unknown key, workerOwned, a Z under another key, and wrong shapes are each rejected", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ ...SECTIONS, headline: "x" }, { error: "unknown_section", field: "headline" }],
      [{ ...SECTIONS, workerOwned: { z: { status: "available", value: -9.99 } } }, { error: "unknown_section", field: "workerOwned" }],
      [{ ...SECTIONS, z: { status: "available", value: 1.23 } }, { error: "unknown_section", field: "z" }],
      [{ ...SECTIONS, worthReading: ["one", "two"] }, { error: "invalid_section", field: "worthReading" }],
      [{ ...SECTIONS, kevinsRead: { paragraphs: ["One."], emphasis: true } }, { error: "invalid_section", field: "kevinsRead" }],
    ];
    for (const [sections, want] of cases) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(envelope({ sections })));
      expect(res.status, JSON.stringify(want)).toBe(400);
      expect(await jsonOf(res)).toEqual(want);
      expect(ops, JSON.stringify(want)).toEqual([]);
    }
  });

  it("anti-vacuity: the conforming payload with that one field fixed is accepted", async () => {
    const { kv, puts } = withParams();
    const fixed = { ...SECTIONS, worthReading: SECTIONS.worthReading };
    expect((await send(envWith(kv), request(envelope({ sections: fixed })))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("sections that are not an object, or missing, are 400 invalid_sections", async () => {
    for (const sections of [undefined, ["lead"], "lead"]) {
      const { kv, ops } = withParams();
      const body = sections === undefined ? { date: NEXT_DUE } : envelope({ sections });
      const res = await send(envWith(kv), request(body));
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: "invalid_sections" });
      expect(ops).toEqual([]);
    }
  });
});

// ─── Test 52 (route level) ───────────────────────────────────────────────

describe("test 52: a non-https Worth Reading link is rejected", () => {
  it("permitting: an absolute https: link is accepted", async () => {
    const { kv, puts } = withParams();
    expect((await send(envWith(kv), request(envelope()))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: http:, javascript:, data: and a relative link are each 400 naming the field — nothing written", async () => {
    for (const link of ["http://example.com/report", "javascript:alert(1)", "data:text/html,x", "/relative"]) {
      const { kv, ops } = withParams();
      const sections = { ...SECTIONS, worthReading: { ...SECTIONS.worthReading, link } };
      const res = await send(envWith(kv), request(envelope({ sections })));
      expect(res.status, link).toBe(400);
      expect(await jsonOf(res), link).toEqual({ error: "invalid_link", field: "worthReading.link" });
      expect(ops, link).toEqual([]);
    }
  });
});

// ─── Test 53 ─────────────────────────────────────────────────────────────

describe("test 53: the fail-closed fetcher", () => {
  it("the fetcher itself: every symbol is an explicit failure with no value", async () => {
    for (const symbol of ["ZC=F", "BTC-USD"] as const) {
      const r = await FAIL_CLOSED_FETCHER.latestCompletedClose(symbol);
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ ok: false, symbol, reason: "no_adapter" });
      expect("close" in r).toBe(false);
    }
  });

  it("permitting: with the parameters seeded, the draft's Z is unavailable/fetch_failed and its sections are byte-for-byte the submitted ones", async () => {
    const { kv, store } = withParams();
    const res = await send(envWith(kv), request(envelope()));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: NEXT_DUE, z: { status: "unavailable", reason: "fetch_failed" } });

    const { workerOwned, ...sections } = storedDraft(store);
    expect(JSON.stringify(sections)).toBe(JSON.stringify(SECTIONS));
    const z = (workerOwned as Record<string, unknown>).z as Record<string, unknown>;
    expect(z).toMatchObject({ status: "unavailable", reason: "fetch_failed" });
  });

  it("forbidding: no Z value, cached price or default is stored, and the response carries codes only", async () => {
    const { kv, store } = withParams();
    const res = await send(envWith(kv), request(envelope()));
    const body = await jsonOf(res);
    const z = ((storedDraft(store).workerOwned as Record<string, unknown>).z ?? {}) as Record<string, unknown>;
    expect(Object.keys(z).sort()).toEqual(["detail", "reason", "status"]);
    for (const k of ["value", "corn", "btc", "bands"]) expect(k in z, k).toBe(false);
    // the stored detail exists — and never reaches the response
    expect(typeof z.detail).toBe("string");
    expect(JSON.stringify(body)).not.toContain(z.detail as string);
    expect(Object.keys(body.z as object).sort()).toEqual(["reason", "status"]);
  });

  it("anti-vacuity: without the parameters the reason is params_unavailable — it is read from the stamped draft, not hard-coded", async () => {
    const { kv } = mockKV();
    const res = await send(envWith(kv), request(envelope()));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: NEXT_DUE, z: { status: "unavailable", reason: "params_unavailable" } });
  });
});

// ─── Test 54 ─────────────────────────────────────────────────────────────

describe("test 54: the bearer is checked before the body is read", () => {
  it("permitting: a correct bearer proceeds to read the body", async () => {
    const { stream, state } = recordingBody(JSON.stringify(envelope()));
    const { kv, puts } = withParams();
    const req = request(stream);
    const res = await send(envWith(kv), req);
    expect(res.status).toBe(200);
    expect(state.pulled).toBe(true);
    expect(req.bodyUsed).toBe(true);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: a wrong or absent bearer (or an unset secret) is rejected with the body NEVER consumed", async () => {
    const cases: Array<[string | null, Record<string, unknown>, number, string]> = [
      [`Bearer ${WRONG}`, {}, 401, "invalid_bearer"],
      [null, {}, 401, "missing_bearer"],
      [`Bearer ${SECRET}`, { DAYBREAK_DRAFT_SECRET: undefined }, 503, "daybreak_draft_not_configured"],
    ];
    for (const [auth, overrides, status, code] of cases) {
      const { stream, state } = recordingBody(JSON.stringify(envelope()));
      const { kv, ops } = withParams();
      const req = request(stream, auth);
      const res = await send(envWith(kv, overrides), req);
      expect(res.status, code).toBe(status);
      expect(await jsonOf(res)).toEqual({ error: code });
      expect(state.pulled, `${code}: body stream was pulled`).toBe(false);
      expect(req.bodyUsed, `${code}: body marked used`).toBe(false);
      expect(ops).toEqual([]);
    }
  });
});

// ─── Test 55 ─────────────────────────────────────────────────────────────

/** A conforming envelope whose JSON is exactly `bytes` long. */
function sized(bytes: number): string {
  const base = JSON.stringify({ date: NEXT_DUE, sections: { lead: "" } });
  const pad = bytes - new TextEncoder().encode(base).byteLength;
  const text = JSON.stringify({ date: NEXT_DUE, sections: { lead: "a".repeat(pad) } });
  expect(new TextEncoder().encode(text).byteLength).toBe(bytes);
  return text;
}

describe("test 55: the body is capped", () => {
  it("the cap is 32 KiB", () => {
    expect(DRAFT_BODY_MAX_BYTES).toBe(32 * 1024);
  });

  it("permitting: a conforming body just under, and exactly at, the cap is accepted", async () => {
    for (const n of [DRAFT_BODY_MAX_BYTES - 1, DRAFT_BODY_MAX_BYTES]) {
      const { kv, puts } = withParams();
      expect((await send(envWith(kv), request(sized(n)))).status, String(n)).toBe(200);
      expect(puts()).toEqual([DRAFT_KEY]);
    }
  });

  it("forbidding: one byte over is 413 body_too_large, and nothing is written", async () => {
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request(sized(DRAFT_BODY_MAX_BYTES + 1)));
    expect(res.status).toBe(413);
    expect(await jsonOf(res)).toEqual({ error: "body_too_large" });
    expect(ops).toEqual([]);
  });

  it("forbidding: the cap is in BYTES — multi-byte text under the cap in characters but over it in bytes is 413", async () => {
    const lead = "é".repeat(DRAFT_BODY_MAX_BYTES / 2); // 2 bytes each
    const text = JSON.stringify({ date: NEXT_DUE, sections: { lead } });
    expect(text.length).toBeLessThan(DRAFT_BODY_MAX_BYTES + 64);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(DRAFT_BODY_MAX_BYTES);
    const { kv, ops } = withParams();
    expect((await send(envWith(kv), request(text))).status).toBe(413);
    expect(ops).toEqual([]);
  });

  it("forbidding: a streamed body with no Content-Length is counted as it arrives and cut off over the cap", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 64) return c.close(); // 64 KiB total — twice the cap
        sent++;
        c.enqueue(chunk);
      },
    });
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request(stream));
    expect(res.status).toBe(413);
    expect(await jsonOf(res)).toEqual({ error: "body_too_large" });
    expect(sent).toBeLessThan(64); // it stopped reading, rather than buffering all of it
    expect(ops).toEqual([]);
  });

  it("forbidding: a declared Content-Length over the cap is 413 before the body is read", async () => {
    const { stream, state } = recordingBody(JSON.stringify(envelope()));
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request(stream, `Bearer ${SECRET}`, { "Content-Length": String(DRAFT_BODY_MAX_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(false);
    expect(ops).toEqual([]);
  });
});

// ─── Test 56 ─────────────────────────────────────────────────────────────

describe("test 56: a member's JWT is not Radar's secret — the route is not JWT-gated", () => {
  it("permitting: the Radar secret is accepted", async () => {
    const { kv, puts } = withParams();
    expect((await send(envWith(kv), request(envelope()))).status).toBe(200);
    expect(puts()).toEqual([DRAFT_KEY]);
  });

  it("forbidding: a valid member JWT of either scope is 401 invalid_bearer — not a JWT-gate code — and nothing is written", async () => {
    for (const scope of ["full", "payment"] as const) {
      const jwt = await signer.token(scope);
      const { kv, ops } = withParams();
      const req = withAuth(request(envelope(), null), jwt);
      expect(req.headers.get("Authorization")).toBe(`Bearer ${jwt}`); // it arrives exactly as a member's does
      const res = await send(envWith(kv), req);
      expect(res.status, scope).toBe(401);
      const body = await jsonOf(res);
      expect(body).toEqual({ error: "invalid_bearer" });
      // Not the JWT gate's answers, which is the point (cf. valuationScope.test.ts).
      expect(body.error).not.toBe("missing");
      expect(body.error).not.toBe("scope_insufficient");
      expect(ops, scope).toEqual([]);
    }
  });
});

// ─── Parsing, dispatch, storage ──────────────────────────────────────────

describe("request parsing, dispatch and storage failure", () => {
  it("invalid JSON is 400 invalid_json; anti-vacuity: valid JSON is accepted", async () => {
    for (const text of ["{not json", "", "￾{"]) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(text));
      expect(res.status, text).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: "invalid_json" });
      expect(ops).toEqual([]);
    }
    const { kv } = withParams();
    expect((await send(envWith(kv), request(JSON.stringify(envelope())))).status).toBe(200);
  });

  it("a body that is not a JSON object is 400 invalid_body; an unknown envelope key is named", async () => {
    for (const text of ["[]", '"x"', "3", "null"]) {
      const { kv, ops } = withParams();
      const res = await send(envWith(kv), request(text));
      expect(res.status, text).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: "invalid_body" });
      expect(ops).toEqual([]);
    }
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), request(envelope({ slot: "published" })));
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "invalid_body", field: "slot" });
    expect(ops).toEqual([]);
  });

  it("only POST dispatches: GET /daybreak/draft is 404", async () => {
    const { kv, ops } = withParams();
    const res = await send(envWith(kv), new Request(ROUTE, { headers: { Authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(404);
    expect(ops).toEqual([]);
  });

  it("a storage failure is 503 daybreak_draft_write_failed with no detail; anti-vacuity: storage working is 200", async () => {
    const failing = withParams({ throwOnPut: true });
    const res = await send(envWith(failing.kv), request(envelope()));
    expect(res.status).toBe(503);
    const body = await jsonOf(res);
    expect(body).toEqual({ error: "daybreak_draft_write_failed" });
    expect(JSON.stringify(body)).not.toContain("daybreak:"); // the key name stays in the log
    const working = withParams();
    expect((await send(envWith(working.kv), request(envelope()))).status).toBe(200);
  });
});
