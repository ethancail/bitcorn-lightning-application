// Router-level tests for the CMS's three Worker editor routes — spec §3.4.5,
// first tests 65–76 and 83–84, the halves the Worker can carry
// (bitcorn-research, specs/2026-09-21-bitcorn-daybreak-spec.md). Tests 77–82,
// 85 and 86, and the proxy and screen halves of 72, 73 and 76, are the treasury
// API's and the editor screen's: part 2. Each test has a PERMITTING and a
// FORBIDDING case, and every "nothing happened" rides with a companion showing
// the same observation could have seen it happen (§5.1, §5.2).
//
// Everything goes through `worker.fetch`, so the router's dispatch is in the
// path. The paths, codes, field names, cap and env var are string LITERALS on
// purpose: they are the contract part 2 is built against, and a rename must
// fail here.
//
// THE READ TAKES NO DATE. It returns both editable editions, N's and P's, in
// one response, so the treasury proxy is one exact path with no query string
// (§3.4.5, EXACT URL MATCH). Its half of test 73 is therefore "it only ever
// returns N and P"; save and publish carry the date in the body and reject
// every other.
//
// TIME. The routes read the real clock, so each test pins it (Date only). THE
// DEFAULT INSTANT: Tue 2026-10-06 09:00 CDT (14:00Z) — test 83's. N = 10-07,
// P = 10-06.
//
// THE NETWORK. A save with no draft runs intake, which fetches closes from
// Yahoo, so every test replaces the global fetch: by default it answers Yahoo's
// 429. No test here reaches the network.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import { publishEdition, writeDraft } from "../src/daybreak/store";
import { yahooChartUrl } from "../src/daybreak/yahooCloses";
import { POWER_LAW_PARAMS_KV_KEY } from "../src/valuation/powerLawParams";
import { ORACLE_PARAMS } from "./fixtures/daybreakPowerLawOracle";
import { createEntitlementSigner, withAuth, type EntitlementSigner } from "./helpers/entitlementToken";
import cornMondayAfternoon from "./daybreak/fixtures/yahoo/zc-f_5d_2026-09-28_afternoon.json";
import cornMondayMidday from "./daybreak/fixtures/yahoo/zc-f_5d_2026-09-28_midday.json";
import btc5d from "./daybreak/fixtures/yahoo/btc-usd_5d_2026-09-28.json";

const NOW = new Date("2026-10-06T14:00:00Z"); // Tue 2026-10-06 09:00 CDT
const N = "2026-10-07";
const P = "2026-10-06";

const READ = "https://w/daybreak/editor";
const SAVE = "https://w/daybreak/editor/save";
const PUBLISH = "https://w/daybreak/editor/publish";
const DRAFT_ROUTE = "https://w/daybreak/draft";
const MEMBER_READ = "https://w/daybreak/edition";

const CAP = 32 * 1024;

const SECRET = "editor-test-secret-0123456789abcdef";
const WRONG = `${SECRET.slice(0, -1)}e`; // same length, differs in its last character only
const DRAFT_SECRET = "radar-test-secret-0123456789abcdef";

const key = (date: string, slot: "draft" | "working" | "published") => `daybreak:${date}:${slot}`;

let signer: EntitlementSigner;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  signer = await createEntitlementSigner();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Too Many Requests", { status: 429 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Op = { op: "get" | "put" | "delete"; key: string };

/** A KV double that records every key touched, and can be told to throw. */
function mockKV(opts: { seed?: Record<string, string>; throwOnGet?: boolean; throwOnPut?: boolean } = {}) {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const ops: Op[] = [];
  const kv = {
    async get(k: string) {
      ops.push({ op: "get", key: k });
      if (opts.throwOnGet) throw new Error(`KV GET failed for ${k}`);
      return store.get(k) ?? null;
    },
    async put(k: string, value: string) {
      ops.push({ op: "put", key: k });
      if (opts.throwOnPut) throw new Error(`KV PUT failed for ${k}`);
      store.set(k, value);
    },
    async delete(k: string) {
      ops.push({ op: "delete", key: k });
      store.delete(k);
    },
  } as unknown as KVNamespace;
  const puts = () => ops.filter((o) => o.op === "put").map((o) => o.key);
  const editionOps = () => ops.filter((o) => o.key.startsWith("daybreak:"));
  return { kv, store, ops, puts, editionOps };
}

const withParams = (opts: { throwOnGet?: boolean; throwOnPut?: boolean } = {}) =>
  mockKV({ ...opts, seed: { [POWER_LAW_PARAMS_KV_KEY]: JSON.stringify(ORACLE_PARAMS) } });

function envWith(kv: KVNamespace, overrides: Record<string, unknown> = {}): Env {
  return {
    PRICES_CACHE: kv,
    DAYBREAK_EDITOR_SECRET: SECRET,
    DAYBREAK_DRAFT_SECRET: DRAFT_SECRET,
    SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX,
    ...overrides,
  } as unknown as Env;
}

// ─── Fixtures ────────────────────────────────────────────────────────────

/** Exactly the five contract keys, each in its contract shape (§3.4.3). */
const SECTIONS = {
  lead: "Corn opened flat; the ratio did not.",
  kevinsRead: "First paragraph.\n\nSecond paragraph.",
  insideAgriculture: "A grain buyer in central Iowa said basis is widening.",
  worthReading: { title: "A report worth your time", note: "Why it matters.", link: "https://example.com/report" },
  closer: "Stack sats, plant corn.",
};

const EDITED = { ...SECTIONS, lead: "Corn closed higher; Kevin rewrote the lead." };

const BAND_TABLE = [
  { lower: null, upper: -1, label: "Fixture band A" },
  { lower: -1, upper: -0.25, label: "Fixture band B" },
  { lower: -0.25, upper: 0.25, label: "Fixture band C" },
  { lower: 0.25, upper: 1, label: "Fixture band D" },
  { lower: 1, upper: null, label: "Fixture band E" },
];

const Z_AVAILABLE = {
  status: "available",
  value: -0.42,
  corn: { date: "2026-10-05", close: 4.1025, fetchedAt: "2026-10-06T03:00:00.000Z" },
  btc: { date: "2026-10-05", close: 63120.5, fetchedAt: "2026-10-06T03:00:01.000Z" },
  bands: { status: "available", table: BAND_TABLE, index: 1 },
};

const draftOf = (sections: Record<string, unknown> = SECTIONS, z: Record<string, unknown> = Z_AVAILABLE) => ({
  ...sections,
  workerOwned: { z },
});

/** Seeds a draft through the store's own write path. */
async function seedDraft(kv: KVNamespace, date: string, content: Record<string, unknown> = draftOf()) {
  expect(await writeDraft(kv, date, content)).toEqual({ ok: true });
}

/** Seeds a published edition through the store's own write path. */
async function seedPublished(kv: KVNamespace, date: string, content: Record<string, unknown> = draftOf()) {
  await seedDraft(kv, date, content);
  expect(await publishEdition(kv, date)).toEqual({ ok: true, source: "draft" });
}

type Body = string | ReadableStream<Uint8Array> | Record<string, unknown>;

function post(url: string, body: Body, authorization: string | null = `Bearer ${SECRET}`, headers: Record<string, string> = {}): Request {
  const h = new Headers({ "Content-Type": "application/json", ...headers });
  if (authorization !== null) h.set("Authorization", authorization);
  const payload = typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body);
  return new Request(url, { method: "POST", headers: h, body: payload });
}

function read(authorization: string | null = `Bearer ${SECRET}`): Request {
  const h = new Headers();
  if (authorization !== null) h.set("Authorization", authorization);
  return new Request(READ, { method: "GET", headers: h });
}

const save = (date: unknown, sections: unknown = SECTIONS, auth?: string | null, headers?: Record<string, string>) =>
  post(SAVE, { date, sections } as Record<string, unknown>, auth, headers);
const publish = (date: unknown, auth?: string | null) => post(PUBLISH, { date } as Record<string, unknown>, auth);

function send(env: Env, req: Request): Promise<Response> {
  return worker.fetch(req, env, {} as any);
}

async function jsonOf(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function memberRead(env: Env): Promise<Record<string, any>> {
  const res = await worker.fetch(withAuth(new Request(MEMBER_READ), await signer.token("payment")), env, {} as any);
  expect(res.status).toBe(200);
  return jsonOf(res);
}

function stored(store: Map<string, string>, k: string): Record<string, any> {
  const raw = store.get(k);
  expect(raw, `${k} must have been written`).toBeDefined();
  return JSON.parse(raw!) as Record<string, any>;
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

/** A conforming save envelope whose JSON is exactly `bytes` long. */
function sizedSave(bytes: number): string {
  const base = JSON.stringify({ date: N, sections: { lead: "" } });
  const pad = bytes - new TextEncoder().encode(base).byteLength;
  const text = JSON.stringify({ date: N, sections: { lead: "a".repeat(pad) } });
  expect(new TextEncoder().encode(text).byteLength).toBe(bytes);
  return text;
}

/** Each route with a request that succeeds on a KV holding a draft for N. */
const ROUTES: Array<{ name: string; make: (auth?: string | null) => Request }> = [
  { name: "read", make: (auth) => read(auth) },
  { name: "save", make: (auth) => save(N, SECTIONS, auth) },
  { name: "publish", make: (auth) => publish(N, auth) },
];

async function kvWithDraftForN() {
  const m = withParams();
  await seedDraft(m.kv, N);
  m.ops.length = 0;
  return m;
}

// ─── Test 66 ─────────────────────────────────────────────────────────────

describe("test 66: secret unset", () => {
  it("permitting: with the secret set, every editor route proceeds", async () => {
    for (const r of ROUTES) {
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), r.make())).status, r.name).toBe(200);
      expect(m.ops.length, `${r.name}: KV was reached`).toBeGreaterThan(0);
    }
  });

  it("forbidding: unset or empty, every route is 503 daybreak_editor_not_configured — before the bearer, the body or KV", async () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    for (const unset of [undefined, ""]) {
      for (const r of ROUTES) {
        const m = await kvWithDraftForN();
        const req = r.make();
        const res = await send(envWith(m.kv, { DAYBREAK_EDITOR_SECRET: unset }), req);
        expect(res.status, r.name).toBe(503);
        expect(await jsonOf(res), r.name).toEqual({ error: "daybreak_editor_not_configured" });
        expect(m.ops, r.name).toEqual([]);
        expect(req.bodyUsed, r.name).toBe(false);
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("forbidding: the drafting secret being set does not configure the editor", async () => {
    const m = await kvWithDraftForN();
    const res = await send(envWith(m.kv, { DAYBREAK_EDITOR_SECRET: undefined }), read(`Bearer ${DRAFT_SECRET}`));
    expect(res.status).toBe(503);
    expect(m.ops).toEqual([]);
  });
});

// ─── Test 65 ─────────────────────────────────────────────────────────────

describe("test 65: the editor bearer", () => {
  it("permitting: the editor secret opens the read, the save and the publish", async () => {
    for (const r of ROUTES) {
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), r.make())).status, r.name).toBe(200);
    }
  });

  it("forbidding: a wrong secret, an absent header, an empty value, a member JWT and DAYBREAK_DRAFT_SECRET are each 401 — nothing read or written", async () => {
    expect(WRONG).toHaveLength(SECRET.length);
    expect(WRONG.slice(0, -1)).toBe(SECRET.slice(0, -1));
    expect(WRONG).not.toBe(SECRET);
    const jwt = await signer.token("full");
    const cases: Array<[string, string | null, string]> = [
      ["wrong secret", `Bearer ${WRONG}`, "invalid_bearer"],
      ["absent header", null, "missing_bearer"],
      ["empty value", "", "missing_bearer"],
      ["empty bearer", "Bearer ", "missing_bearer"],
      ["member JWT", `Bearer ${jwt}`, "invalid_bearer"],
      ["drafting secret", `Bearer ${DRAFT_SECRET}`, "invalid_bearer"],
    ];
    for (const r of ROUTES) {
      for (const [why, auth, code] of cases) {
        const m = await kvWithDraftForN();
        const res = await send(envWith(m.kv), r.make(auth));
        expect(res.status, `${r.name}: ${why}`).toBe(401);
        expect(await jsonOf(res), `${r.name}: ${why}`).toEqual({ error: code });
        expect(m.ops, `${r.name}: ${why}`).toEqual([]);
      }
    }
  });

  it("anti-vacuity: the SAME request with the editor secret succeeds", async () => {
    for (const r of ROUTES) {
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), r.make(`Bearer ${WRONG}`))).status, r.name).toBe(401);
      expect(m.ops).toEqual([]);
      expect((await send(envWith(m.kv), r.make(`Bearer ${SECRET}`))).status, r.name).toBe(200);
      expect(m.ops.length).toBeGreaterThan(0);
    }
  });

  it("review property: crypto.subtle.timingSafeEqual sees two 32-byte digests per presented bearer, on every route", async () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    const bearers: Array<[string, number]> = [
      [SECRET, 200],
      [WRONG, 401],
      ["x", 401],
      [`${SECRET}-and-a-much-longer-suffix`, 401],
    ];
    for (const r of ROUTES) {
      spy.mockClear();
      for (const [bearer, status] of bearers) {
        const m = await kvWithDraftForN();
        expect((await send(envWith(m.kv), r.make(`Bearer ${bearer}`))).status, `${r.name}: ${bearer}`).toBe(status);
      }
      expect(spy, r.name).toHaveBeenCalledTimes(bearers.length);
      for (const [a, b] of spy.mock.calls) {
        expect((a as ArrayBuffer).byteLength, r.name).toBe(32);
        expect((b as ArrayBuffer).byteLength, r.name).toBe(32);
      }
      expect(spy.mock.results.map((x) => x.value), r.name).toEqual([true, false, false, false]);
    }
  });
});

// ─── Test 67 ─────────────────────────────────────────────────────────────

describe("test 67: bearer before body; body capped", () => {
  const bodyRoutes = [
    { name: "save", url: SAVE, body: () => JSON.stringify({ date: N, sections: SECTIONS }) },
    { name: "publish", url: PUBLISH, body: () => JSON.stringify({ date: N }) },
  ];

  it("permitting: with the correct bearer, the body is read", async () => {
    for (const r of bodyRoutes) {
      const { stream, state } = recordingBody(r.body());
      const m = await kvWithDraftForN();
      const req = post(r.url, stream);
      expect((await send(envWith(m.kv), req)).status, r.name).toBe(200);
      expect(state.pulled, r.name).toBe(true);
      expect(req.bodyUsed, r.name).toBe(true);
    }
  });

  it("forbidding: a wrong or absent bearer, or an unset secret, rejects with the body NEVER read", async () => {
    const cases: Array<[string | null, Record<string, unknown>, number, string]> = [
      [`Bearer ${WRONG}`, {}, 401, "invalid_bearer"],
      [null, {}, 401, "missing_bearer"],
      [`Bearer ${SECRET}`, { DAYBREAK_EDITOR_SECRET: undefined }, 503, "daybreak_editor_not_configured"],
    ];
    for (const r of bodyRoutes) {
      for (const [auth, overrides, status, code] of cases) {
        const { stream, state } = recordingBody(r.body());
        const m = await kvWithDraftForN();
        const req = post(r.url, stream, auth);
        const res = await send(envWith(m.kv, overrides), req);
        expect(res.status, `${r.name}: ${code}`).toBe(status);
        expect(await jsonOf(res)).toEqual({ error: code });
        expect(state.pulled, `${r.name}: ${code}: body stream was pulled`).toBe(false);
        expect(req.bodyUsed, `${r.name}: ${code}: body marked used`).toBe(false);
        expect(m.ops).toEqual([]);
      }
    }
  });

  it("permitting: a conforming save just under, and exactly at, 32 KiB is accepted", async () => {
    for (const n of [CAP - 1, CAP]) {
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), post(SAVE, sizedSave(n)))).status, String(n)).toBe(200);
      expect(m.puts()).toEqual([key(N, "working")]);
    }
  });

  it("forbidding: one byte over is 413 body_too_large on save and on publish, and nothing is read or written", async () => {
    const overPublish = JSON.stringify({ date: N, pad: "a".repeat(CAP) });
    for (const [url, text] of [[SAVE, sizedSave(CAP + 1)], [PUBLISH, overPublish]] as const) {
      const m = await kvWithDraftForN();
      const res = await send(envWith(m.kv), post(url, text));
      expect(res.status, url).toBe(413);
      expect(await jsonOf(res)).toEqual({ error: "body_too_large" });
      expect(m.ops, url).toEqual([]);
    }
  });

  it("forbidding: a streamed body with no Content-Length is cut off over the cap", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 64) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const m = await kvWithDraftForN();
    const res = await send(envWith(m.kv), post(SAVE, stream));
    expect(res.status).toBe(413);
    expect(await jsonOf(res)).toEqual({ error: "body_too_large" });
    expect(sent).toBeLessThan(64);
    expect(m.ops).toEqual([]);
  });

  it("forbidding: a declared Content-Length over the cap is 413 with the body unread", async () => {
    for (const r of bodyRoutes) {
      const { stream, state } = recordingBody(r.body());
      const m = await kvWithDraftForN();
      const res = await send(envWith(m.kv), post(r.url, stream, `Bearer ${SECRET}`, { "Content-Length": String(CAP + 1) }));
      expect(res.status, r.name).toBe(413);
      expect(state.pulled, r.name).toBe(false);
      expect(m.ops).toEqual([]);
    }
  });
});

// ─── Test 68 ─────────────────────────────────────────────────────────────

describe("test 68: both doors open, and distinct (R2)", () => {
  it("permitting: POST /daybreak/draft with its secret still writes N's draft, and the editor save writes the working key", async () => {
    const m = withParams();
    const env = envWith(m.kv);
    const drafted = await send(env, post(DRAFT_ROUTE, { date: N, sections: SECTIONS }, `Bearer ${DRAFT_SECRET}`));
    expect(drafted.status).toBe(200);
    expect(m.puts()).toEqual([key(N, "draft")]);
    const saved = await send(env, save(N, EDITED));
    expect(saved.status).toBe(200);
    expect(m.puts()).toEqual([key(N, "draft"), key(N, "working")]);
    expect(stored(m.store, key(N, "working")).lead).toBe(EDITED.lead);
  });

  it("forbidding: the drafting secret on every editor route, and the editor secret on /daybreak/draft, are rejected with nothing written", async () => {
    for (const r of ROUTES) {
      const m = await kvWithDraftForN();
      const res = await send(envWith(m.kv), r.make(`Bearer ${DRAFT_SECRET}`));
      expect(res.status, r.name).toBe(401);
      expect(await jsonOf(res)).toEqual({ error: "invalid_bearer" });
      expect(m.ops).toEqual([]);
    }
    const m = withParams();
    const res = await send(envWith(m.kv), post(DRAFT_ROUTE, { date: N, sections: SECTIONS }, `Bearer ${SECRET}`));
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "invalid_bearer" });
    expect(m.ops).toEqual([]);
  });
});

// ─── Test 69 ─────────────────────────────────────────────────────────────

describe("test 69: the read strips as the member read does", () => {
  // The stored block carries a detail, an unknown key in the Z, and an unknown
  // key in the block itself — each naming KV keys — so their absence from the
  // response is a finding, not an accident of the fixture.
  const Z_WITH_EXTRAS = {
    ...Z_AVAILABLE,
    detail: "computed from KV key daybreak_powerlaw_params_v1",
    diagnostics: "intermediate",
  };
  const WORKING = { ...EDITED, workerOwned: { z: Z_WITH_EXTRAS, sourceKey: key(P, "draft") } };

  async function seeded() {
    const m = withParams();
    await seedDraft(m.kv, P);
    m.store.set(key(P, "working"), JSON.stringify(WORKING));
    m.ops.length = 0;
    return m;
  }

  it("permitting: the stored working copy's sections, and its available Z's value, closes and bands, are returned", async () => {
    const m = await seeded();
    const res = await send(envWith(m.kv), read());
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.recent.date).toBe(P);
    const { workerOwned, ...sections } = body.recent.content;
    expect(sections).toEqual(EDITED);
    expect(workerOwned).toEqual({
      z: { status: "available", value: Z_AVAILABLE.value, corn: Z_AVAILABLE.corn, btc: Z_AVAILABLE.btc, bands: Z_AVAILABLE.bands },
    });
  });

  it("forbidding: no detail, no KV key name and no unknown workerOwned key reaches the response", async () => {
    const m = await seeded();
    const res = await send(envWith(m.kv), read());
    // Anchored: the scan runs over a response that DOES carry the edition, so a
    // 404 or an error body cannot pass it by having nothing in it.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).recent.content.workerOwned.z.value).toBe(Z_AVAILABLE.value);
    for (const needle of ["detail", "daybreak:", "daybreak_powerlaw_", "diagnostics", "sourceKey"]) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it("anti-vacuity: the fixture's stored block does carry them", async () => {
    const m = await seeded();
    const raw = m.store.get(key(P, "working"))!;
    for (const needle of ["detail", "daybreak:", "daybreak_powerlaw_", "diagnostics", "sourceKey"]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("forbidding: a corrupt stored value, or a KV throw, gives the generic code — and the key name is in the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = await seeded();
    m.store.set(key(P, "working"), "{not json");
    const res = await send(envWith(m.kv), read());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "daybreak_editor_failed" });
    expect(text).not.toContain("daybreak:");
    expect(log.mock.calls.flat().join(" ")).toContain(key(P, "working"));

    const throwing = withParams({ throwOnGet: true });
    const thrown = await send(envWith(throwing.kv), read());
    expect(thrown.status).toBe(503);
    expect(await jsonOf(thrown)).toEqual({ error: "daybreak_editor_failed" });
  });

  it("the read reports whether each date's edition is published (yes or no, no time), and no_draft when there is no copy", async () => {
    const m = withParams();
    await seedPublished(m.kv, P);
    const body = await jsonOf(await send(envWith(m.kv), read()));
    expect(Object.keys(body).sort()).toEqual(["next", "recent"]);
    expect(body.next).toEqual({ date: N, published: false, code: "no_draft" });
    expect(body.recent.published).toBe(true);
    expect(Object.keys(body.recent).sort()).toEqual(["content", "date", "published"]);
  });

  it("the read prefers working over draft (F.2's precedence)", async () => {
    const m = withParams();
    await seedDraft(m.kv, P, draftOf(SECTIONS));
    m.store.set(key(P, "working"), JSON.stringify(draftOf(EDITED)));
    const body = await jsonOf(await send(envWith(m.kv), read()));
    expect(body.recent.content.lead).toBe(EDITED.lead);
    m.store.delete(key(P, "working"));
    const body2 = await jsonOf(await send(envWith(m.kv), read()));
    expect(body2.recent.content.lead).toBe(SECTIONS.lead);
  });
});

// ─── Test 70 ─────────────────────────────────────────────────────────────

describe("test 70: the save validates (R4)", () => {
  it("permitting: the five contract sections are accepted, and the working key is written", async () => {
    const m = await kvWithDraftForN();
    expect((await send(envWith(m.kv), save(N, SECTIONS))).status).toBe(200);
    expect(m.puts()).toEqual([key(N, "working")]);
  });

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["an unknown key", { ...SECTIONS, headline: "x" }, { error: "unknown_section", field: "headline" }],
    ["workerOwned", { ...SECTIONS, workerOwned: { z: { status: "available", value: -9.99 } } }, { error: "unknown_section", field: "workerOwned" }],
    ["a Z under another key", { ...SECTIONS, z: { status: "available", value: 1.23 } }, { error: "unknown_section", field: "z" }],
    ["Worth Reading as an array", { ...SECTIONS, worthReading: ["one", "two"] }, { error: "invalid_section", field: "worthReading" }],
    ["Kevin's Read as an object", { ...SECTIONS, kevinsRead: { paragraphs: ["One."] } }, { error: "invalid_section", field: "kevinsRead" }],
    [
      "a non-https link",
      { ...SECTIONS, worthReading: { ...SECTIONS.worthReading, link: "http://example.com/report" } },
      { error: "invalid_link", field: "worthReading.link" },
    ],
  ];

  it("forbidding: each off-contract payload is a 400 naming the field, and neither :working nor :draft is written — with or without a draft", async () => {
    for (const [why, sections, want] of cases) {
      for (const withDraft of [true, false]) {
        const m = withDraft ? await kvWithDraftForN() : withParams();
        const res = await send(envWith(m.kv), save(N, sections));
        expect(res.status, why).toBe(400);
        expect(await jsonOf(res), why).toEqual(want);
        expect(m.puts(), `${why} (draft: ${withDraft})`).toEqual([]);
        expect(m.editionOps(), `${why} (draft: ${withDraft})`).toEqual([]);
      }
    }
  });

  it("anti-vacuity: the same payload with that field fixed is accepted", async () => {
    for (const [why, sections] of cases) {
      const fixed: Record<string, unknown> = { ...sections };
      for (const k of Object.keys(fixed)) if (!(k in SECTIONS)) delete fixed[k];
      for (const k of Object.keys(SECTIONS) as Array<keyof typeof SECTIONS>) fixed[k] = SECTIONS[k];
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), save(N, fixed))).status, why).toBe(200);
      expect(m.puts(), why).toEqual([key(N, "working")]);
    }
  });

  it("sections absent or not an object are 400 invalid_sections; an unknown envelope key is named", async () => {
    for (const body of [{ date: N }, { date: N, sections: ["lead"] }, { date: N, sections: "lead" }]) {
      const m = await kvWithDraftForN();
      const res = await send(envWith(m.kv), post(SAVE, body));
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: "invalid_sections" });
      expect(m.ops).toEqual([]);
    }
    const m = await kvWithDraftForN();
    const res = await send(envWith(m.kv), post(SAVE, { date: N, sections: SECTIONS, author: "kevin" }));
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "invalid_body", field: "author" });
    expect(m.ops).toEqual([]);
  });
});

// ─── Worth Reading: an empty field (the save) ────────────────────────────

// Ethan's ruling: the shared validator refuses an empty Worth Reading title,
// note or link, as the editor screen does — "empty" is the screen's trimmed
// notion. The drafting route's half is in tests/daybreakDraftRoute.test.ts.
describe("Worth Reading: an empty title, note or link — the save refuses it", () => {
  const BLANKS = ["", " ", "\t\n  \r\n"];
  const wr = (patch: Record<string, unknown>) => ({ ...SECTIONS, worthReading: { ...SECTIONS.worthReading, ...patch } });

  it("permitting: a title, a note and a link each holding something are accepted, padding included", async () => {
    for (const patch of [{ title: "x" }, { title: "  A padded title  " }, { note: "x" }, { note: "\tA padded note\n" }, { link: "https://a.example/" }]) {
      const m = await kvWithDraftForN();
      expect((await send(envWith(m.kv), save(N, wr(patch)))).status, JSON.stringify(patch)).toBe(200);
      expect(m.puts(), JSON.stringify(patch)).toEqual([key(N, "working")]);
    }
  });

  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["title", { error: "invalid_section", field: "worthReading.title" }],
    ["note", { error: "invalid_section", field: "worthReading.note" }],
    ["link", { error: "invalid_link", field: "worthReading.link" }],
  ];
  for (const [field, want] of forbidden) {
    it(`forbidding: an empty or whitespace-only ${field} is a 400 naming the field; neither :working nor :draft is written — with or without a draft`, async () => {
      for (const blank of BLANKS) {
        for (const withDraft of [true, false]) {
          const why = `${JSON.stringify(blank)} (draft: ${withDraft})`;
          const m = withDraft ? await kvWithDraftForN() : withParams();
          const res = await send(envWith(m.kv), save(N, wr({ [field]: blank })));
          expect(res.status, why).toBe(400);
          expect(await jsonOf(res), why).toEqual(want);
          expect(m.puts(), why).toEqual([]);
          expect(m.editionOps(), why).toEqual([]);
        }
      }
    });
  }
});

// ─── Test 71 ─────────────────────────────────────────────────────────────

describe("test 71: publish, and republish with no mark (R4, R7)", () => {
  it("permitting: publish copies working, else draft; a second publish after an edit replaces the content", async () => {
    const m = withParams();
    await seedDraft(m.kv, P);
    const env = envWith(m.kv);

    const first = await send(env, publish(P));
    expect(first.status).toBe(200);
    expect(await jsonOf(first)).toEqual({ date: P });
    expect(m.store.get(key(P, "published"))).toBe(m.store.get(key(P, "draft"))); // no working yet → the draft
    const firstValue = stored(m.store, key(P, "published"));

    expect((await send(env, save(P, EDITED))).status).toBe(200);
    expect((await send(env, publish(P))).status).toBe(200);
    expect(m.store.get(key(P, "published"))).toBe(m.store.get(key(P, "working"))); // working wins
    const second = stored(m.store, key(P, "published"));

    // anti-vacuity: the two publishes' sections differ
    expect(second.lead).toBe(EDITED.lead);
    expect(firstValue.lead).toBe(SECTIONS.lead);
    expect(second.lead).not.toBe(firstValue.lead);

    // forbidding: no updated, time, count or author field
    expect(Object.keys(second).sort()).toEqual(Object.keys(firstValue).sort());
    expect(Object.keys(second.workerOwned).sort()).toEqual(Object.keys(firstValue.workerOwned).sort());

    // the member read shows the replacement, and no mark
    const member = await memberRead(env);
    expect(member.state).toBe("current");
    expect(member.edition.date).toBe(P);
    expect(member.edition.content.lead).toBe(EDITED.lead);
    expect(Object.keys(member).sort()).toEqual(["dueDate", "edition", "state"]);
    expect(Object.keys(member.edition).sort()).toEqual(["content", "date"]);
  });

  it("forbidding: with neither working nor draft, publish is 409 nothing_to_publish and writes nothing", async () => {
    const m = withParams();
    const res = await send(envWith(m.kv), publish(P));
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "nothing_to_publish" });
    expect(m.puts()).toEqual([]);
  });

  it("forbidding: publish takes only a date — any other key is 400 invalid_body naming it", async () => {
    const m = withParams();
    await seedDraft(m.kv, P);
    m.ops.length = 0;
    const res = await send(envWith(m.kv), post(PUBLISH, { date: P, sections: SECTIONS }));
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "invalid_body", field: "sections" });
    expect(m.ops).toEqual([]);
  });
});

// ─── Test 72 ─────────────────────────────────────────────────────────────

describe("test 72: no author (R1) — the Worker's half; the proxy's is part 2", () => {
  it("permitting: a save stores the sent sections and workerOwned; forbidding: exactly those top-level keys", async () => {
    const m = await kvWithDraftForN();
    expect((await send(envWith(m.kv), save(N, EDITED))).status).toBe(200);
    const w = stored(m.store, key(N, "working"));
    expect(Object.keys(w).sort()).toEqual([...Object.keys(EDITED), "workerOwned"].sort());
  });

  it("anti-vacuity: two different source addresses and User-Agents store byte-identical values", async () => {
    const a = await kvWithDraftForN();
    const b = await kvWithDraftForN();
    const ra = await send(envWith(a.kv), save(N, EDITED, `Bearer ${SECRET}`, { "User-Agent": "KevinPhone/1.0", "CF-Connecting-IP": "100.64.0.1", "X-Forwarded-For": "100.64.0.1" }));
    const rb = await send(envWith(b.kv), save(N, EDITED, `Bearer ${SECRET}`, { "User-Agent": "Desktop/2.0", "CF-Connecting-IP": "100.64.0.2", "X-Forwarded-For": "100.64.0.2" }));
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(a.store.get(key(N, "working"))).toBeDefined();
    expect(a.store.get(key(N, "working"))).toBe(b.store.get(key(N, "working")));
    for (const s of [a.store, b.store]) {
      const raw = s.get(key(N, "working"))!;
      for (const needle of ["KevinPhone", "Desktop", "100.64.0."]) expect(raw, needle).not.toContain(needle);
    }
  });
});

// ─── Test 73 ─────────────────────────────────────────────────────────────

describe("test 73: which dates (R6) — exactly N and P", () => {
  type Instant = { label: string; at: string; n: string; p: string; accept: string[]; reject: string[] };
  const INSTANTS: Instant[] = [
    { label: "Tue 2026-10-06 05:59:59 CDT", at: "2026-10-06T10:59:59Z", n: "2026-10-06", p: "2026-10-05", accept: ["2026-10-06", "2026-10-05"], reject: ["2026-10-02", "2026-10-04", "2026-10-07"] },
    { label: "Tue 2026-10-06 06:00:00 CDT, 10-06 unpublished", at: "2026-10-06T11:00:00Z", n: "2026-10-07", p: "2026-10-06", accept: ["2026-10-07", "2026-10-06"], reject: ["2026-10-05", "2026-10-08"] },
    { label: "Sat 2026-10-10 12:00 CDT", at: "2026-10-10T17:00:00Z", n: "2026-10-12", p: "2026-10-09", accept: ["2026-10-12", "2026-10-09"], reject: ["2026-10-10", "2026-10-11", "2026-10-08"] },
  ];

  for (const t of INSTANTS) {
    describe(t.label, () => {
      beforeEach(() => {
        vi.setSystemTime(new Date(t.at));
      });

      it("permitting: the read returns N (next) and P (recent), and nothing else", async () => {
        const m = withParams();
        const body = await jsonOf(await send(envWith(m.kv), read()));
        expect(body.next.date).toBe(t.n);
        expect(body.recent.date).toBe(t.p);
        expect(Object.keys(body).sort()).toEqual(["next", "recent"]);
        // it read only those two dates' keys
        const dates = new Set(m.editionOps().map((o) => o.key.split(":")[1]));
        expect([...dates].sort()).toEqual([t.n, t.p].sort());
      });

      it("permitting: the save and the publish accept each of N and P", async () => {
        for (const date of t.accept) {
          const m = withParams();
          await seedDraft(m.kv, date);
          const env = envWith(m.kv);
          expect((await send(env, save(date, EDITED))).status, `save ${date}`).toBe(200);
          expect((await send(env, publish(date))).status, `publish ${date}`).toBe(200);
          expect(stored(m.store, key(date, "published")).lead).toBe(EDITED.lead);
        }
      });

      it("forbidding: every other date is 422 not_editable_date on save and publish, and nothing is read or written", async () => {
        for (const date of t.reject) {
          for (const make of [() => save(date, EDITED), () => publish(date)]) {
            const m = withParams();
            await seedDraft(m.kv, date);
            m.ops.length = 0;
            const res = await send(envWith(m.kv), make());
            expect(res.status, date).toBe(422);
            expect(await jsonOf(res), date).toEqual({ error: "not_editable_date" });
            expect(m.ops, date).toEqual([]);
          }
        }
      });

      it("exactly two: a sweep from 14 days before to 14 days after accepts N and P only, on save and on publish", async () => {
        const base = Date.parse(`${t.p}T00:00:00Z`);
        const acceptedSave: string[] = [];
        const acceptedPublish: string[] = [];
        for (let d = -14; d <= 14; d++) {
          const date = new Date(base + d * 86_400_000).toISOString().slice(0, 10);
          const m = withParams();
          await seedDraft(m.kv, date);
          const env = envWith(m.kv);
          const s = await send(env, save(date, EDITED));
          if (s.status === 200) acceptedSave.push(date);
          else expect(s.status, date).toBe(422);
          const p = await send(env, publish(date));
          if (p.status === 200) acceptedPublish.push(date);
          else expect(p.status, date).toBe(422);
        }
        expect(acceptedSave.sort()).toEqual([t.n, t.p].sort());
        expect(acceptedPublish.sort()).toEqual([t.n, t.p].sort());
      });
    });
  }

  it("forbidding: a malformed or absent date is 400 invalid_date on save and publish, and nothing is read or written", async () => {
    vi.setSystemTime(new Date("2026-10-06T11:00:00Z"));
    const bad: unknown[] = ["2026-10-6", "2026-02-30", "06/10/2026", "2026-10-06T00:00:00Z", 20261006, null];
    for (const date of bad) {
      for (const make of [() => save(date), () => publish(date)]) {
        const m = withParams();
        const res = await send(envWith(m.kv), make());
        expect(res.status, String(date)).toBe(400);
        expect(await jsonOf(res), String(date)).toEqual({ error: "invalid_date" });
        expect(m.ops, String(date)).toEqual([]);
      }
    }
    for (const body of [{ sections: SECTIONS }, {}]) {
      const m = withParams();
      const res = await send(envWith(m.kv), post(body.sections ? SAVE : PUBLISH, body));
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toEqual({ error: "invalid_date" });
      expect(m.ops).toEqual([]);
    }
  });
});

// ─── Test 74 ─────────────────────────────────────────────────────────────

describe("test 74: no draft — the save creates it, through intake (R8)", () => {
  // Mon 2026-09-28 22:00 CDT: N = 09-29, P = 09-28. The real Yahoo captures
  // give finished closes dated 09-28 — the draft route's own wired-adapter case.
  const AT = new Date("2026-09-29T03:00:00Z");
  const N74 = "2026-09-29";

  function serveCaptures(corn: unknown = cornMondayAfternoon) {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url === yahooChartUrl("ZC=F")) return new Response(JSON.stringify(corn));
      if (url === yahooChartUrl("BTC-USD")) return new Response(JSON.stringify(btc5d));
      return new Response("unexpected", { status: 599 });
    });
  }

  beforeEach(() => {
    vi.setSystemTime(AT);
  });

  it("permitting: with parameters and captures, the save writes :draft with an available Z, then :working holds the sections plus that Z, and a publish succeeds", async () => {
    serveCaptures();
    const m = withParams();
    const env = envWith(m.kv);
    const res = await send(env, save(N74, EDITED));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: N74, z: { status: "available" } });
    expect(m.puts()).toEqual([key(N74, "draft"), key(N74, "working")]);

    const draft = stored(m.store, key(N74, "draft"));
    const working = stored(m.store, key(N74, "working"));
    expect(draft.workerOwned.z.status).toBe("available");
    expect(draft.workerOwned.z.corn.date).toBe("2026-09-28");
    expect(working.workerOwned).toEqual(draft.workerOwned);
    const { workerOwned: _w, ...sections } = working;
    expect(sections).toEqual(EDITED);

    expect((await send(env, publish(N74))).status).toBe(200);
    expect(m.store.get(key(N74, "published"))).toBe(m.store.get(key(N74, "working")));
  });

  it("permitting: without parameters, the created draft's Z is unavailable with params_unavailable", async () => {
    const m = mockKV();
    const res = await send(envWith(m.kv), save(N74, EDITED));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: N74, z: { status: "unavailable", reason: "params_unavailable" } });
    expect(m.puts()).toEqual([key(N74, "draft"), key(N74, "working")]);
    expect(stored(m.store, key(N74, "working")).workerOwned.z.reason).toBe("params_unavailable");
  });

  it("forbidding: a payload Z never survives, and no draft is created for a date R6 rejects", async () => {
    serveCaptures();
    const m = withParams();
    const res = await send(envWith(m.kv), save(N74, { ...EDITED, workerOwned: { z: { status: "available", value: 9 } } }));
    expect(res.status).toBe(400);
    expect(m.puts()).toEqual([]);

    const rejected = withParams();
    expect((await send(envWith(rejected.kv), save("2026-09-30", EDITED))).status).toBe(422);
    expect(rejected.ops).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("anti-vacuity: with a draft present, the save runs no intake and leaves the draft unchanged", async () => {
    serveCaptures();
    const m = withParams();
    await seedDraft(m.kv, N74);
    const before = m.store.get(key(N74, "draft"));
    expect((await send(envWith(m.kv), save(N74, EDITED))).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.store.get(key(N74, "draft"))).toBe(before);
    expect(m.puts()).toEqual([key(N74, "draft"), key(N74, "working")]); // the seed's put, then the save's
  });

  it("anti-vacuity: a later POST /daybreak/draft for N replaces the draft and not :working", async () => {
    serveCaptures();
    const m = withParams();
    const env = envWith(m.kv);
    expect((await send(env, save(N74, EDITED))).status).toBe(200);
    const draftBefore = m.store.get(key(N74, "draft"));
    const workingBefore = m.store.get(key(N74, "working"));
    const rerun = { ...SECTIONS, lead: "Radar's re-run." };
    expect((await send(env, post(DRAFT_ROUTE, { date: N74, sections: rerun }, `Bearer ${DRAFT_SECRET}`))).status).toBe(200);
    expect(m.store.get(key(N74, "draft"))).not.toBe(draftBefore);
    expect(stored(m.store, key(N74, "draft")).lead).toBe(rerun.lead);
    expect(m.store.get(key(N74, "working"))).toBe(workingBefore);
  });

  it("as specified, not worked around: a no-draft save for P on Monday morning stores future_dated_close (the spec's open finding)", async () => {
    // Mon 2026-09-28 05:00 CDT: P = Fri 09-25. Bitcoin's latest finished bar
    // is Sunday 09-27's, dated after P, so the Z fails closed with its reason.
    vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
    serveCaptures(cornMondayMidday);
    const m = withParams();
    const res = await send(envWith(m.kv), save("2026-09-25", EDITED));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: "2026-09-25", z: { status: "unavailable", reason: "future_dated_close" } });
  });
});

// ─── Test 75 ─────────────────────────────────────────────────────────────

describe("test 75: no newer-draft notice, no start-over (R9)", () => {
  it("permitting: after a drafting-agent re-run, with a working key present, the read returns the working copy — with the same key set", async () => {
    const m = withParams();
    const env = envWith(m.kv);
    expect((await send(env, post(DRAFT_ROUTE, { date: N, sections: SECTIONS }, `Bearer ${DRAFT_SECRET}`))).status).toBe(200);
    expect((await send(env, save(N, EDITED))).status).toBe(200);
    const before = await jsonOf(await send(env, read()));
    const draftBefore = m.store.get(key(N, "draft"));
    const workingBefore = m.store.get(key(N, "working"));

    expect((await send(env, post(DRAFT_ROUTE, { date: N, sections: { ...SECTIONS, lead: "Radar again." } }, `Bearer ${DRAFT_SECRET}`))).status).toBe(200);
    // anti-vacuity: the draft key did change
    expect(m.store.get(key(N, "draft"))).not.toBe(draftBefore);

    const after = await jsonOf(await send(env, read()));
    expect(after.next.content.lead).toBe(EDITED.lead);
    expect(Object.keys(after.next).sort()).toEqual(Object.keys(before.next).sort());
    expect(after).toEqual(before);
    // forbidding: no route copied the draft over the working key
    expect(m.store.get(key(N, "working"))).toBe(workingBefore);
  });
});

// ─── Test 76 ─────────────────────────────────────────────────────────────

describe("test 76: the Z's status is not checked against the text (R10) — the Worker's half; the render is part 2", () => {
  it("permitting: the save reports the working key's Z status after the save", async () => {
    const m = await kvWithDraftForN();
    const body = await jsonOf(await send(envWith(m.kv), save(N, SECTIONS)));
    expect(body).toEqual({ date: N, z: { status: "available" } });
  });

  it("forbidding: a save whose text says the Z is unavailable, while it is available, is accepted with no warning", async () => {
    const m = await kvWithDraftForN();
    const text = { ...SECTIONS, lead: "The Z is unavailable today." };
    const res = await send(envWith(m.kv), save(N, text));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ date: N, z: { status: "available" } });
    expect(stored(m.store, key(N, "working")).lead).toBe(text.lead);
  });
});

// ─── Test 83 ─────────────────────────────────────────────────────────────

describe("test 83: a late publish of today's edition (A)", () => {
  // Tue 2026-10-06 09:00 CDT (the default instant). A draft exists for 10-06,
  // 10-06 is not published, and Monday's 10-05 is.
  async function seeded() {
    const m = withParams();
    await seedPublished(m.kv, "2026-10-05", draftOf({ ...SECTIONS, lead: "Monday's edition." }));
    await seedDraft(m.kv, "2026-10-06");
    m.ops.length = 0;
    return m;
  }

  it("permitting: the read, the save and the publish of 10-06 each succeed; after the publish, the member read is current on 10-06", async () => {
    const m = await seeded();
    const env = envWith(m.kv);
    const r = await jsonOf(await send(env, read()));
    expect(r.recent).toMatchObject({ date: "2026-10-06", published: false });
    expect(r.recent.content.lead).toBe(SECTIONS.lead);

    expect((await send(env, save("2026-10-06", EDITED))).status).toBe(200);
    // forbidding: the save alone publishes nothing
    expect(m.store.has(key("2026-10-06", "published"))).toBe(false);
    const heldOver = await memberRead(env);
    expect(heldOver.state).toBe("held_over");
    expect(heldOver.edition.date).toBe("2026-10-05");

    expect((await send(env, publish("2026-10-06"))).status).toBe(200);
    const current = await memberRead(env);
    expect(current.state).toBe("current");
    expect(current.edition.date).toBe("2026-10-06");
    expect(current.edition.content.lead).toBe(EDITED.lead);
  });

  it("permitting: a save of 10-06 sent at 06:00:01 CDT, from a screen loaded at 05:58 when 10-06 was N, is accepted", async () => {
    vi.setSystemTime(new Date("2026-10-06T10:58:00Z"));
    const m = await seeded();
    const env = envWith(m.kv);
    expect((await jsonOf(await send(env, read()))).next.date).toBe("2026-10-06");
    vi.setSystemTime(new Date("2026-10-06T11:00:01Z"));
    expect((await send(env, save("2026-10-06", EDITED))).status).toBe(200);
  });

  it("forbidding: at 09:00, 10-05 is no longer P — its save and publish are rejected and nothing is written; the read does not return it", async () => {
    const m = await seeded();
    const env = envWith(m.kv);
    for (const make of [() => save("2026-10-05", EDITED), () => publish("2026-10-05")]) {
      const before = m.ops.length;
      const res = await send(env, make());
      expect(res.status).toBe(422);
      expect(await jsonOf(res)).toEqual({ error: "not_editable_date" });
      expect(m.ops.length).toBe(before);
    }
    const r = await jsonOf(await send(env, read()));
    expect([r.next.date, r.recent.date]).not.toContain("2026-10-05");
  });

  it("anti-vacuity: at 05:59:59 CDT the same 10-05 requests are accepted, because 10-05 was P then", async () => {
    vi.setSystemTime(new Date("2026-10-06T10:59:59Z"));
    const m = await seeded();
    const env = envWith(m.kv);
    expect((await send(env, save("2026-10-05", EDITED))).status).toBe(200);
    expect((await send(env, publish("2026-10-05"))).status).toBe(200);
    expect((await jsonOf(await send(env, read()))).recent.date).toBe("2026-10-05");
  });
});

// ─── Test 84 ─────────────────────────────────────────────────────────────

describe("test 84: Friday's edition opened on a Saturday (A)", () => {
  async function seeded() {
    const m = withParams();
    await seedPublished(m.kv, "2026-10-09");
    m.ops.length = 0;
    return m;
  }

  it("permitting: Sat 12:00 — the read returns 10-09's copy and says it is published; a corrected save and publish replace it, and the member read shows the correction", async () => {
    vi.setSystemTime(new Date("2026-10-10T17:00:00Z"));
    const m = await seeded();
    const env = envWith(m.kv);
    const r = await jsonOf(await send(env, read()));
    expect(r.recent).toMatchObject({ date: "2026-10-09", published: true });
    expect(r.recent.content.lead).toBe(SECTIONS.lead);
    expect(r.next.date).toBe("2026-10-12");

    expect((await send(env, save("2026-10-09", EDITED))).status).toBe(200);
    expect((await send(env, publish("2026-10-09"))).status).toBe(200);
    expect(stored(m.store, key("2026-10-09", "published")).lead).toBe(EDITED.lead);
    const member = await memberRead(env);
    expect(member.edition.date).toBe("2026-10-09");
    expect(member.edition.content.lead).toBe(EDITED.lead);
  });

  it("forbidding: Saturday's own date and 10-08 are rejected with nothing written", async () => {
    vi.setSystemTime(new Date("2026-10-10T17:00:00Z"));
    for (const date of ["2026-10-10", "2026-10-08"]) {
      for (const make of [() => save(date, EDITED), () => publish(date)]) {
        const m = await seeded();
        const res = await send(envWith(m.kv), make());
        expect(res.status, date).toBe(422);
        expect(m.ops, date).toEqual([]);
      }
    }
  });

  it("forbidding: at Mon 2026-10-12 06:00:00 CDT, 10-09 is rejected — P is now 10-12", async () => {
    vi.setSystemTime(new Date("2026-10-12T11:00:00Z"));
    const m = await seeded();
    const res = await send(envWith(m.kv), save("2026-10-09", EDITED));
    expect(res.status).toBe(422);
    expect(m.ops).toEqual([]);
    expect((await jsonOf(await send(envWith(m.kv), read()))).recent.date).toBe("2026-10-12");
  });

  it("anti-vacuity: at Mon 2026-10-12 05:59:59 CDT, 10-09 is still accepted", async () => {
    vi.setSystemTime(new Date("2026-10-12T10:59:59Z"));
    const m = await seeded();
    expect((await send(envWith(m.kv), save("2026-10-09", EDITED))).status).toBe(200);
  });
});

// ─── Codes only ──────────────────────────────────────────────────────────

describe("codes only: every editor response body is a code, a field name, a date, or a Z status and reason code", () => {
  const CODES = new Set([
    "daybreak_editor_not_configured",
    "missing_bearer",
    "invalid_bearer",
    "body_too_large",
    "invalid_json",
    "invalid_body",
    "invalid_date",
    "not_editable_date",
    "invalid_sections",
    "unknown_section",
    "invalid_section",
    "invalid_link",
    "nothing_to_publish",
    "daybreak_editor_failed",
  ]);
  const FIELD = /^[A-Za-z]+(\.[A-Za-z]+)?$/;

  async function expectCodeBody(res: Response, why: string) {
    expect(res.headers.get("Content-Type"), why).toBe("application/json");
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${why}: body is not JSON: ${text}`);
    }
    expect(Object.keys(body).every((k) => k === "error" || k === "field"), `${why}: ${text}`).toBe(true);
    expect(CODES.has(body.error as string), `${why}: ${text}`).toBe(true);
    if ("field" in body) expect(body.field, why).toMatch(FIELD);
  }

  it("forbidding: every refusal and failure, on every route, is { error: <code>, field?: <name> }", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: Array<[string, () => Promise<Response>]> = [];
    const add = (why: string, env: () => Promise<Env> | Env, req: () => Request) =>
      failures.push([why, async () => send(await env(), req())]);
    const plain = () => envWith(withParams().kv);

    for (const r of ROUTES) {
      add(`${r.name}: unset`, () => envWith(withParams().kv, { DAYBREAK_EDITOR_SECRET: "" }), () => r.make());
      add(`${r.name}: missing bearer`, plain, () => r.make(null));
      add(`${r.name}: wrong bearer`, plain, () => r.make(`Bearer ${WRONG}`));
      add(`${r.name}: KV throws`, () => envWith(withParams({ throwOnGet: true }).kv), () => r.make());
    }
    add("read: corrupt stored value", async () => {
      const m = withParams();
      m.store.set(key(N, "working"), "{not json");
      return envWith(m.kv);
    }, () => read());
    for (const url of [SAVE, PUBLISH]) {
      add(`${url}: too large`, plain, () => post(url, "a".repeat(CAP + 1)));
      add(`${url}: bad json`, plain, () => post(url, "{not json"));
      add(`${url}: not an object`, plain, () => post(url, "[]"));
      add(`${url}: extra key`, plain, () => post(url, { date: N, sections: SECTIONS, extra: 1 }));
      add(`${url}: malformed date`, plain, () => post(url, url === SAVE ? { date: "x", sections: SECTIONS } : { date: "x" }));
      add(`${url}: other date`, plain, () => post(url, url === SAVE ? { date: "2026-10-08", sections: SECTIONS } : { date: "2026-10-08" }));
    }
    add("save: sections", plain, () => save(N, { ...SECTIONS, headline: "x" }));
    add("save: link", plain, () => save(N, { ...SECTIONS, worthReading: { ...SECTIONS.worthReading, link: "http://x" } }));
    add("save: KV put throws", async () => {
      const m = withParams({ throwOnPut: true });
      return envWith(m.kv);
    }, () => save(N));
    add("publish: nothing", plain, () => publish(N));
    add("publish: KV put throws", async () => {
      const m = withParams({ throwOnPut: true });
      m.store.set(key(N, "draft"), JSON.stringify(draftOf()));
      return envWith(m.kv);
    }, () => publish(N));

    for (const [why, run] of failures) {
      const res = await run();
      expect(res.status, why).toBeGreaterThanOrEqual(400);
      await expectCodeBody(res, why);
    }
  });

  it("permitting: the successes carry only dates, booleans, a code, the sanitised content, and a Z status and reason code", async () => {
    const m = withParams();
    const env = envWith(m.kv);
    const saved = await jsonOf(await send(env, save(N, EDITED)));
    expect(Object.keys(saved).sort()).toEqual(["date", "z"]);
    expect(saved.z).toEqual({ status: "unavailable", reason: "fetch_failed" });
    const published = await jsonOf(await send(env, publish(N)));
    expect(published).toEqual({ date: N });
  });

  it("anti-vacuity: the store failure's detail does exist — in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = withParams({ throwOnPut: true });
    const res = await send(envWith(m.kv), save(N));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("KV PUT failed");
    expect(log.mock.calls.flat().join(" ")).toContain("KV PUT failed");
  });
});

// ─── Dispatch ────────────────────────────────────────────────────────────

describe("dispatch: each path answers only its method", () => {
  it("GET on save or publish, and POST on the read, are 404 — and touch nothing", async () => {
    for (const req of [
      new Request(SAVE, { headers: { Authorization: `Bearer ${SECRET}` } }),
      new Request(PUBLISH, { headers: { Authorization: `Bearer ${SECRET}` } }),
      post(READ, {}),
    ]) {
      const m = withParams();
      const res = await send(envWith(m.kv), req);
      expect(res.status, `${req.method} ${req.url}`).toBe(404);
      expect(m.ops).toEqual([]);
    }
  });
});
