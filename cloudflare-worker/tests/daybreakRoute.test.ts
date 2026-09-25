// Router-level tests for the Daybreak member read, GET /daybreak/edition —
// spec §3.4.2, first tests 27–30, 32 and 34 (bitcorn-research, specs/2026-09-21-bitcorn-
// daybreak-spec.md). Each has a PERMITTING and a FORBIDDING case, and every
// "X is absent" assertion carries a companion showing X was there to be seen.
//
// Everything goes through `worker.fetch`, so the JWT gate, the router and the
// handler are all in the path (tests/baseScope.test.ts explains why a
// handler-level test would leave the gate uncovered).
//
// TIME. The route reads the real clock (`new Date()`), so each test pins it with
// vi.setSystemTime. Only Date is faked: timers stay real, because the gate's
// crypto and the KV mock are promise-based and a faked setTimeout would buy
// nothing but a place to hang. Tokens are minted AFTER the clock is pinned, so
// their iat/exp sit on the same faked clock the gate verifies against.
//
// THE PINNED INSTANT: Wednesday 2026-09-23, 07:00 CDT (12:00Z). Under the
// default Mon–Fri calendar the most recent due instant is 06:00 CDT that same
// day, so the due date is 2026-09-23 — which is what lets one clock produce all
// three states from three fixtures.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import { publishEdition, writeDraft } from "../src/daybreak/store";
import {
  createEntitlementSigner,
  withAuth,
  type EntitlementSigner,
} from "./helpers/entitlementToken";

const NOW = new Date("2026-09-23T12:00:00Z"); // Wed 07:00 CDT
const TODAY = "2026-09-23";
const YESTERDAY = "2026-09-22";
const ROUTE = "https://w/daybreak/edition";

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

/**
 * A KV double that records every key read, and can be told to throw. The
 * thrown message names the key on purpose: test 30's anti-vacuity needs a key
 * name to exist in the underlying detail, so that its absence from the response
 * body is a finding rather than an accident of the fixture.
 */
function mockKV(opts: { throwOnGet?: boolean } = {}) {
  const store = new Map<string, string>();
  const gets: string[] = [];
  const kv = {
    async get(key: string) {
      gets.push(key);
      if (opts.throwOnGet) throw new Error(`KV GET failed for ${key}`);
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, gets };
}

function envWith(kv: KVNamespace): Env {
  return { PRICES_CACHE: kv, SUBSCRIPTION_PUBLIC_KEY: signer.publicKeyX } as unknown as Env;
}

/** Seeds a published edition through the store's own write path. */
async function publish(kv: KVNamespace, date: string, content: Record<string, unknown>) {
  expect(await writeDraft(kv, date, content)).toEqual({ ok: true });
  expect(await publishEdition(kv, date)).toEqual({ ok: true, source: "draft" });
}

async function get(env: Env, scope: "full" | "payment" | null = "payment"): Promise<Response> {
  const req = new Request(ROUTE);
  return worker.fetch(scope ? withAuth(req, await signer.token(scope)) : req, env, {} as any);
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const SECTIONS = {
  lead: "Corn opened flat.",
  kevinsRead: { paragraphs: ["One.", "Two."], emphasis: true },
};

const Z_AVAILABLE = {
  status: "available",
  value: -0.42,
  corn: { date: "2026-09-22", close: 4.1025, fetchedAt: "2026-09-22T23:10:00.000Z" },
  btc: { date: "2026-09-22", close: 63120.5, fetchedAt: "2026-09-22T23:10:01.000Z" },
};

// A real-shaped detail from powerLawParams.ts:39 — the exact kind of string
// the spec says must never reach a member.
const Z_UNAVAILABLE = {
  status: "unavailable",
  reason: "params_unavailable",
  detail: "absent: KV key daybreak_powerlaw_params_v1 is not set",
};

function edition(z: Record<string, unknown>) {
  return { ...SECTIONS, workerOwned: { z } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 27 — Worker route auth.
// ═══════════════════════════════════════════════════════════════════════════

describe("test 27 — route auth: subscriber-base (payment) scope", () => {
  for (const scope of ["payment", "full"] as const) {
    it(`PERMITS a ${scope}-scope token: 200 with the edition, read from KV`, async () => {
      const { kv, gets } = mockKV();
      await publish(kv, TODAY, edition(Z_AVAILABLE));
      gets.length = 0;

      const res = await get(envWith(kv), scope);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: string; edition: { date: string } };
      // Asserted positively — the fixture's own state and date — so a 200 from
      // anywhere but this handler could not satisfy it.
      expect(body.state).toBe("current");
      expect(body.edition.date).toBe(TODAY);
      expect(gets.length).toBeGreaterThan(0);
    });
  }

  it("FORBIDS a request with no token: 401 missing, and nothing is read from KV", async () => {
    const { kv, gets } = mockKV();
    await publish(kv, TODAY, edition(Z_AVAILABLE));
    gets.length = 0;

    const res = await get(envWith(kv), null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing");
    expect(gets).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 28 — each edition state, from a fixture built to produce it.
// ═══════════════════════════════════════════════════════════════════════════

describe("test 28 — each edition state", () => {
  const FIXTURES: Array<{
    state: "current" | "held_over" | "unavailable";
    seed: (kv: KVNamespace) => Promise<void>;
  }> = [
    // Today's edition exists → dated on the due date → current.
    { state: "current", seed: (kv) => publish(kv, TODAY, edition(Z_AVAILABLE)) },
    // Only yesterday's, and today's 06:00 due instant has passed → held over.
    { state: "held_over", seed: (kv) => publish(kv, YESTERDAY, edition(Z_AVAILABLE)) },
    // Nothing published within the 14-date walk → unavailable.
    { state: "unavailable", seed: async () => {} },
  ];

  for (const f of FIXTURES) {
    it(`a fixture built for ${f.state} returns ${f.state}, and no other state`, async () => {
      const { kv } = mockKV();
      await f.seed(kv);

      const res = await get(envWith(kv));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: string };
      expect(body.state).toBe(f.state);
      for (const other of FIXTURES.filter((o) => o.state !== f.state)) {
        expect(body.state).not.toBe(other.state);
      }
    });
  }

  it("held over carries the due date and the older edition's own date", async () => {
    const { kv } = mockKV();
    await publish(kv, YESTERDAY, edition(Z_AVAILABLE));

    const body = (await (await get(envWith(kv))).json()) as {
      state: string;
      dueDate: string;
      edition: { date: string };
    };
    expect(body).toMatchObject({ state: "held_over", dueDate: TODAY, edition: { date: YESTERDAY } });
  });

  it("unavailable carries no edition", async () => {
    const { kv } = mockKV();
    const body = (await (await get(envWith(kv))).json()) as Record<string, unknown>;
    expect(body).toEqual({ state: "unavailable" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 29 — codes, not detail; and the allowlist behind it.
// ═══════════════════════════════════════════════════════════════════════════

describe("test 29 — codes, not detail", () => {
  it("an UNAVAILABLE Z carries its reason code and NO detail field", async () => {
    const { kv, store } = mockKV();
    await publish(kv, TODAY, edition(Z_UNAVAILABLE));
    // Anti-vacuity: the stored edition really does carry the detail, so its
    // absence below is the route's doing.
    expect(store.get(`daybreak:${TODAY}:published`)).toContain("daybreak_powerlaw_params_v1");

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: { workerOwned: { z: Record<string, unknown> } } };
    };
    const z = body.edition.content.workerOwned.z;
    expect(z.status).toBe("unavailable");
    expect(z.reason).toBe("params_unavailable");
    expect(z).not.toHaveProperty("detail");
    expect(JSON.stringify(body)).not.toContain("daybreak_powerlaw_params_v1");
  });

  it("anti-vacuity: an AVAILABLE Z in the same response shape still carries its value and both closes", async () => {
    const { kv } = mockKV();
    await publish(kv, TODAY, edition(Z_AVAILABLE));

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: { workerOwned: { z: Record<string, unknown> } } };
    };
    expect(body.edition.content.workerOwned.z).toEqual(Z_AVAILABLE);
  });

  it("workerOwned is sanitised by ALLOWLIST: unknown keys at every level are dropped", async () => {
    const { kv, store } = mockKV();
    const tampered = {
      ...SECTIONS,
      workerOwned: {
        z: {
          ...Z_AVAILABLE,
          trend: 1.2345, // a computation intermediate
          corn: { ...Z_AVAILABLE.corn, raw: "vendor payload" },
          btc: { ...Z_AVAILABLE.btc, source: "internal" },
        },
        internalNote: "must not reach a member",
      },
    };
    await publish(kv, TODAY, tampered);
    // Anti-vacuity: every extra field is in the stored edition.
    const stored = store.get(`daybreak:${TODAY}:published`)!;
    for (const s of ["trend", "vendor payload", "internal", "internalNote"]) expect(stored).toContain(s);

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: Record<string, unknown> };
    };
    expect(body.edition.content.workerOwned).toEqual({ z: Z_AVAILABLE });
    const text = JSON.stringify(body);
    for (const s of ["trend", "vendor payload", "internalNote"]) expect(text).not.toContain(s);
  });

  it("the written sections pass through untouched", async () => {
    const { kv } = mockKV();
    await publish(kv, TODAY, edition(Z_UNAVAILABLE));

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: Record<string, unknown> };
    };
    const { workerOwned: _owned, ...sections } = body.edition.content;
    expect(sections).toEqual(SECTIONS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 32 — an unrecognized Z block reaches the member as UNAVAILABLE (ruled
// 2026-09-24: shown unavailable with one generic code, never dropped).
// ═══════════════════════════════════════════════════════════════════════════

// The generic code, written out rather than imported so that on a tree
// without it this suite fails on the dropped block, not on a missing export.
const Z_UNRECOGNIZED = "unrecognized_z";

// intake.ts's ZUnavailableReason, listed by hand: tests are outside the
// Worker's tsconfig. The compile-time guard that the generic code is not one of
// these lives in handlers/daybreak.ts.
const INTAKE_REASONS = ["params_unavailable", "fetch_failed", "future_dated_close", "stale_close", "computation_failed"];

describe("test 32 — an unrecognized Z block reaches the member as unavailable", () => {
  const UNRECOGNIZED: Array<{ name: string; z: Record<string, unknown>; stored: string }> = [
    { name: "an unavailable Z with an unknown reason", z: { status: "unavailable", reason: "not_a_known_code" }, stored: "not_a_known_code" },
    { name: "a Z with an unknown status", z: { status: "bogus" }, stored: "bogus" },
  ];

  it("the generic code is not one of intake's reasons", () => {
    expect(INTAKE_REASONS).not.toContain(Z_UNRECOGNIZED);
  });

  for (const f of UNRECOGNIZED) {
    it(`${f.name} → { status: "unavailable", reason: "${Z_UNRECOGNIZED}" }, never {} and never the stored field`, async () => {
      const { kv, store } = mockKV();
      await publish(kv, TODAY, edition(f.z));
      // Anti-vacuity: the stored block really carries the unrecognized value.
      expect(store.get(`daybreak:${TODAY}:published`)).toContain(f.stored);

      const res = await get(envWith(kv));
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { edition: { content: { workerOwned: Record<string, unknown> } } };

      // FORBIDS: never an empty workerOwned.
      expect(body.edition.content.workerOwned).not.toEqual({});
      // PERMITS: exactly the generic unavailable Z — toEqual also forbids any
      // other stored field riding along.
      expect(body.edition.content.workerOwned).toEqual({ z: { status: "unavailable", reason: Z_UNRECOGNIZED } });
      // FORBIDS: the stored block's unknown value never reaches the member.
      expect(text).not.toContain(f.stored);
    });
  }

  it("anti-vacuity: a VALID available Z in the same fixture shape still carries its value and both closes", async () => {
    const { kv } = mockKV();
    await publish(kv, TODAY, edition(Z_AVAILABLE));

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: { workerOwned: Record<string, unknown> } };
    };
    expect(body.edition.content.workerOwned).toEqual({ z: Z_AVAILABLE });
  });

  it("a KNOWN intake reason still passes through as itself, not as the generic code", async () => {
    const { kv } = mockKV();
    await publish(kv, TODAY, edition({ status: "unavailable", reason: "stale_close" }));

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: { workerOwned: Record<string, unknown> } };
    };
    expect(body.edition.content.workerOwned).toEqual({ z: { status: "unavailable", reason: "stale_close" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 34 — every absent or malformed Z reaches the member as unavailable
// (ruled 2026-09-25: a member never receives an edition with no Z block).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 34 — every absent or malformed Z reaches the member as unavailable", () => {
  const UNRECOGNIZED_BLOCK = { z: { status: "unavailable", reason: Z_UNRECOGNIZED } };

  // `stored` is a string the stored fixture carries that must not reach the
  // member — undefined where the fixture has nothing of its own to leak.
  const CASES: Array<{ name: string; content: Record<string, unknown>; stored?: string }> = [
    { name: "(a) workerOwned MISSING", content: { ...SECTIONS } },
    { name: "(b) workerOwned a string", content: { ...SECTIONS, workerOwned: "not_an_object_payload" }, stored: "not_an_object_payload" },
    { name: "(b) workerOwned an array", content: { ...SECTIONS, workerOwned: ["array_payload"] }, stored: "array_payload" },
    { name: "(b) workerOwned null", content: { ...SECTIONS, workerOwned: null } },
    { name: "(c) workerOwned with NO z (empty)", content: { ...SECTIONS, workerOwned: {} } },
    { name: "(c) workerOwned with NO z (other keys only)", content: { ...SECTIONS, workerOwned: { market: "other_key_payload" } }, stored: "other_key_payload" },
  ];

  for (const c of CASES) {
    it(`${c.name} → workerOwned: { z: unavailable ${Z_UNRECOGNIZED} }, never an edition without a Z block`, async () => {
      const { kv, store } = mockKV();
      await publish(kv, TODAY, c.content);
      // Anti-vacuity: the stored edition really has the fixture's shape.
      const stored = JSON.parse(store.get(`daybreak:${TODAY}:published`)!) as Record<string, unknown>;
      if ("workerOwned" in c.content) expect(stored.workerOwned).toEqual(c.content.workerOwned);
      else expect(stored).not.toHaveProperty("workerOwned");

      const res = await get(envWith(kv));
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { edition: { content: Record<string, unknown> } };
      const content = body.edition.content;

      // FORBIDS: never an edition with no workerOwned key, or with no z.
      expect(content).toHaveProperty("workerOwned");
      expect(content.workerOwned).toHaveProperty("z");
      // PERMITS: exactly the generic unavailable block — toEqual also forbids
      // the stored non-object or any stored key riding along.
      expect(content.workerOwned).toEqual(UNRECOGNIZED_BLOCK);
      if (c.stored) expect(text).not.toContain(c.stored);
      // The written sections are untouched by the substitution.
      const { workerOwned: _owned, ...sections } = content;
      expect(sections).toEqual(SECTIONS);
    });
  }

  it("anti-vacuity: a VALID available Z in the same fixture shape still carries its value and both closes", async () => {
    const { kv } = mockKV();
    await publish(kv, TODAY, edition(Z_AVAILABLE));

    const body = (await (await get(envWith(kv))).json()) as {
      edition: { content: { workerOwned: { z: Record<string, unknown> } } };
    };
    expect(body.edition.content.workerOwned).toEqual({ z: Z_AVAILABLE });
    expect(body.edition.content.workerOwned.z.value).toBe(Z_AVAILABLE.value);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 30 — store errors and KV throws: one generic code, no key names.
// ═══════════════════════════════════════════════════════════════════════════

// Every key string this read path can touch or mention.
const KEY_STRINGS = ["daybreak:", "daybreak_powerlaw_params_v1", ":published", ":draft", ":working"];

describe("test 30 — store errors and KV throws", () => {
  const CASES: Array<{ name: string; setup: () => ReturnType<typeof mockKV> }> = [
    {
      name: "a store error (unparseable JSON under the published key)",
      setup: () => {
        const m = mockKV();
        m.store.set(`daybreak:${TODAY}:published`, "{not json");
        return m;
      },
    },
    {
      name: "a store error (a published value that is not a JSON object)",
      setup: () => {
        const m = mockKV();
        m.store.set(`daybreak:${TODAY}:published`, "[1,2,3]");
        return m;
      },
    },
    { name: "a KV get that THROWS", setup: () => mockKV({ throwOnGet: true }) },
  ];

  for (const c of CASES) {
    it(`${c.name} → 503 daybreak_read_failed, no key name in the body, detail logged`, async () => {
      const logged: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
      const { kv } = c.setup();

      const res = await get(envWith(kv));
      const text = await res.text();

      expect(res.status).toBe(503);
      // The key-name scan runs BEFORE the exact-body check, so a leak is
      // reported as a leak (by the scan) rather than as a generic body mismatch.
      for (const k of KEY_STRINGS) expect(text, `response body leaks "${k}"`).not.toContain(k);
      expect(JSON.parse(text)).toEqual({ error: "daybreak_read_failed" });
      // Anti-vacuity: the key name exists in the underlying detail, and that
      // detail went to the log.
      expect(logged.join("\n")).toContain(`daybreak:${TODAY}:published`);
    });
  }
});
