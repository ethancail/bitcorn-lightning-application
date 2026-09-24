// Daybreak working save (src/daybreak/workingSave.ts): Kevin's save takes the
// Worker-owned fields from the DRAFT, server-side (I.1), ONCE — at the first
// save for an edition date — and every later save keeps the working key's own
// (J.3). The editor can never set them.
//
// Drafts are produced by the real intake (runDraftIntake) against a mock
// fetcher, so the Worker-owned fields under test are genuine stamped Zs.
// Numbered tests refer to the Daybreak spec's first-tests list (§3.4.1).

import { describe, expect, it } from "vitest";
import type { CloseFetcher, CloseFetchResult, PriceSymbol } from "../../src/daybreak/closes";
import { runDraftIntake, WORKER_OWNED_KEY } from "../../src/daybreak/intake";
import { publishEdition, readDraft, readWorking, writeDraft } from "../../src/daybreak/store";
import { saveWorking } from "../../src/daybreak/workingSave";
import { POWER_LAW_PARAMS_KV_KEY } from "../../src/valuation/powerLawParams";
import { ORACLE_PARAMS } from "../fixtures/daybreakPowerLawOracle";

type Op = { op: "get" | "put" | "delete"; key: string };

function mockKV() {
  const store = new Map<string, string>([[POWER_LAW_PARAMS_KV_KEY, JSON.stringify(ORACLE_PARAMS)]]);
  const ops: Op[] = [];
  const kv = {
    async get(key: string) {
      ops.push({ op: "get", key });
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      ops.push({ op: "put", key });
      store.set(key, value);
    },
    async delete(key: string) {
      ops.push({ op: "delete", key });
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store, ops, reset: () => (ops.length = 0) };
}

function fetcherFor(corn: CloseFetchResult | null, btc: CloseFetchResult | null): CloseFetcher {
  return {
    async latestCompletedClose(symbol: PriceSymbol) {
      const r = symbol === "ZC=F" ? corn : btc;
      return r ?? { ok: false, symbol, reason: "http_error", detail: "HTTP 429" };
    },
  };
}

const EDITION = "2026-09-29";
const at = "2026-09-29T02:00:00.000Z";
const closesA = fetcherFor(
  { ok: true, symbol: "ZC=F", date: "2026-09-28", close: 4.1, fetchedAt: at },
  { ok: true, symbol: "BTC-USD", date: "2026-09-28", close: 110_000, fetchedAt: at },
);
const closesB = fetcherFor(
  { ok: true, symbol: "ZC=F", date: "2026-09-28", close: 3.2, fetchedAt: at },
  { ok: true, symbol: "BTC-USD", date: "2026-09-28", close: 140_000, fetchedAt: at },
);
const closesFail = fetcherFor(null, null);

const agentSections = { lead: "agent lead", closer: "agent closer" };
const kevinFirst = { lead: "Kevin's lead, first save", closer: "Kevin's closer" };
const kevinSecond = { lead: "Kevin's lead, SECOND save", closer: "Kevin's closer, revised" };

function stored(store: Map<string, string>, slot: "draft" | "working" | "published"): Record<string, unknown> {
  const raw = store.get(`daybreak:${EDITION}:${slot}`);
  expect(raw, `daybreak:${EDITION}:${slot} must exist`).toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}
const owned = (c: Record<string, unknown>) => c[WORKER_OWNED_KEY] as { z: Record<string, unknown> };

async function draftWith(kv: KVNamespace, fetcher: CloseFetcher) {
  expect((await runDraftIntake({ kv, fetcher }, EDITION, agentSections)).ok).toBe(true);
}

// ─── Test 18: an editor save whose payload includes a Z ───────────────────

describe("test 18: an editor save whose payload includes a Z (and close dates)", () => {
  const FORGED = {
    z: { status: "available", value: 7.77, corn: { date: "2019-01-01", close: 1 }, btc: { date: "2019-01-01", close: 1 } },
  };

  it("anti-vacuity: the payload's Z differs from the draft's", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    expect(owned(stored(store, "draft")).z.value).not.toBe(FORGED.z.value);
  });

  it("permitting: the working key's Z block and close dates EQUAL the draft's", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    const r = await saveWorking(kv, EDITION, { ...kevinFirst, [WORKER_OWNED_KEY]: FORGED });
    expect(r).toEqual({ ok: true, workerOwnedFrom: "draft" });
    expect(owned(stored(store, "working"))).toEqual(owned(stored(store, "draft")));
  });

  it("forbidding: the payload's values NEVER reach the working key; the editor's sections do", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    await saveWorking(kv, EDITION, { ...kevinFirst, [WORKER_OWNED_KEY]: FORGED });
    const working = stored(store, "working");
    expect(JSON.stringify(working[WORKER_OWNED_KEY])).not.toContain("7.77");
    expect(JSON.stringify(working[WORKER_OWNED_KEY])).not.toContain("2019-01-01");
    const { [WORKER_OWNED_KEY]: _o, ...sections } = working;
    expect(sections).toEqual(kevinFirst);
  });

  it("forbidding on a LATER save too: a forged Z on the second save never replaces the kept one", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    await saveWorking(kv, EDITION, kevinFirst);
    const kept = owned(stored(store, "working"));
    const r = await saveWorking(kv, EDITION, { ...kevinSecond, [WORKER_OWNED_KEY]: FORGED });
    expect(r).toEqual({ ok: true, workerOwnedFrom: "working" });
    expect(owned(stored(store, "working"))).toEqual(kept);
  });

  it("a payload WITHOUT a Z still produces a working key carrying the draft's Z", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    await saveWorking(kv, EDITION, kevinFirst);
    const z = owned(stored(store, "working")).z;
    expect(z.status).toBe("available");
    expect(z).toEqual(owned(stored(store, "draft")).z);
  });
});

// ─── Test 19: a drafting-agent re-run AFTER Kevin's last save ─────────────

describe("test 19: a drafting-agent re-run after Kevin's last save", () => {
  it("permitting: the draft key changes to the re-run's; forbidding: the working key's numbers are unchanged and publish carries Kevin's", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    await saveWorking(kv, EDITION, kevinFirst);
    const savedAgainst = owned(stored(store, "working"));

    await draftWith(kv, closesB); // the late re-run
    const draftB = owned(stored(store, "draft"));
    expect(draftB.z.value).not.toBe(savedAgainst.z.value); // anti-vacuity: the re-run really changed the numbers

    expect(owned(stored(store, "working"))).toEqual(savedAgainst);
    expect((await publishEdition(kv, EDITION)).ok).toBe(true);
    expect(owned(stored(store, "published"))).toEqual(savedAgainst);
    expect(owned(stored(store, "published"))).not.toEqual(draftB);
  });
});

// ─── Test 22: a re-run BETWEEN two working saves (J.3) ────────────────────

describe("test 22: a drafting-agent re-run BETWEEN two working saves", () => {
  async function sequence() {
    const { kv, store, ops, reset } = mockKV();
    await draftWith(kv, closesA); // draft A
    const draftA = owned(stored(store, "draft"));
    expect((await saveWorking(kv, EDITION, kevinFirst)).ok).toBe(true); // Kevin's first save
    const copiedAtFirst = owned(stored(store, "working"));
    await draftWith(kv, closesB); // re-run writes draft B
    const draftB = owned(stored(store, "draft"));
    reset();
    const second = await saveWorking(kv, EDITION, kevinSecond); // Kevin's second save
    return { store, ops, draftA, draftB, copiedAtFirst, second };
  }

  it("anti-vacuity: draft B's Z differs from draft A's, and the draft key itself holds B", async () => {
    const { store, draftA, draftB } = await sequence();
    expect(draftB.z.value).not.toBe(draftA.z.value);
    expect(owned(stored(store, "draft"))).toEqual(draftB);
  });

  it("permitting: after the second save the working key's Worker-owned fields EQUAL those copied at the first save (draft A's)", async () => {
    const { store, draftA, copiedAtFirst, second } = await sequence();
    expect(second).toEqual({ ok: true, workerOwnedFrom: "working" });
    expect(copiedAtFirst).toEqual(draftA);
    expect(owned(stored(store, "working"))).toEqual(copiedAtFirst);
    const { [WORKER_OWNED_KEY]: _o, ...sections } = stored(store, "working");
    expect(sections).toEqual(kevinSecond); // the second save really landed
  });

  it("forbidding: they NEVER equal draft B's, and the later save never even reads the draft key", async () => {
    const { store, ops, draftB } = await sequence();
    expect(owned(stored(store, "working"))).not.toEqual(draftB);
    expect(ops.filter((o) => o.key === `daybreak:${EDITION}:draft`)).toEqual([]);
  });
});

// ─── J.3's flagged consequence: an unavailable Z at the first save is kept ─

describe("J.3 consequence (flagged in J's record): an UNAVAILABLE Z captured at the first save is kept through later saves", () => {
  it("a later successful re-run does not reach the working key", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesFail);
    await saveWorking(kv, EDITION, kevinFirst);
    expect(owned(stored(store, "working")).z.status).toBe("unavailable");
    await draftWith(kv, closesA);
    expect(owned(stored(store, "draft")).z.status).toBe("available"); // the re-run did succeed
    await saveWorking(kv, EDITION, kevinSecond);
    expect(owned(stored(store, "working")).z.status).toBe("unavailable");
  });
});

// ─── No draft at the first save: an explicit error (Ethan's open question) ─

describe("no draft exists at the first save", () => {
  it("permitting: with a draft present the first save succeeds", async () => {
    const { kv, store } = mockKV();
    await draftWith(kv, closesA);
    expect((await saveWorking(kv, EDITION, kevinFirst)).ok).toBe(true);
    expect(store.has(`daybreak:${EDITION}:working`)).toBe(true);
  });

  it("forbidding: with no draft the save is an explicit error and NOTHING is written", async () => {
    const { kv, store, ops } = mockKV();
    const r = await saveWorking(kv, EDITION, kevinFirst);
    expect(r).toMatchObject({ ok: false, reason: "no_draft" });
    expect(ops.filter((o) => o.op !== "get")).toEqual([]);
    expect(store.has(`daybreak:${EDITION}:working`)).toBe(false);
  });

  it("forbidding: a draft written WITHOUT intake (no reserved key) is also refused — the save never invents Worker-owned fields", async () => {
    const { kv, ops, reset } = mockKV();
    expect((await writeDraft(kv, EDITION, agentSections)).ok).toBe(true);
    reset();
    const r = await saveWorking(kv, EDITION, { ...kevinFirst, [WORKER_OWNED_KEY]: { z: { status: "available", value: 1 } } });
    expect(r).toMatchObject({ ok: false, reason: "missing_worker_owned" });
    expect(ops.filter((o) => o.op !== "get")).toEqual([]);
  });
});

// ─── Input validation and the two new seam reads ───────────────────────────

describe("working save input validation", () => {
  it("rejects a missing/malformed date and non-object content, writing nothing", async () => {
    const { kv, ops } = mockKV();
    await draftWith(kv, closesA);
    const before = ops.filter((o) => o.op === "put").length;
    expect(await saveWorking(kv, "2026-9-29", kevinFirst)).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(await saveWorking(kv, undefined as unknown as string, kevinFirst)).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(await saveWorking(kv, EDITION, [] as unknown as Record<string, unknown>)).toMatchObject({ ok: false, reason: "invalid_content" });
    expect(ops.filter((o) => o.op === "put").length).toBe(before);
  });
});

describe("store seam: readDraft / readWorking", () => {
  it("permitting: each returns its own slot's content", async () => {
    const { kv } = mockKV();
    await writeDraft(kv, EDITION, { which: "draft" });
    expect(await readDraft(kv, EDITION)).toEqual({ ok: true, found: true, content: { which: "draft" } });
    expect(await readWorking(kv, EDITION)).toEqual({ ok: true, found: false });
  });

  it("forbidding: an invalid date is rejected, and a corrupt slot is an explicit error, never empty", async () => {
    const { kv, store } = mockKV();
    expect(await readDraft(kv, "nope")).toMatchObject({ ok: false, reason: "invalid_date" });
    expect(await readWorking(kv, "nope")).toMatchObject({ ok: false, reason: "invalid_date" });
    store.set(`daybreak:${EDITION}:working`, "{not json");
    expect(await readWorking(kv, EDITION)).toMatchObject({ ok: false, reason: "unparseable" });
  });
});
