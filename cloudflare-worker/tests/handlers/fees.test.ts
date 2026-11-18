import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  FEES_CACHE_TTL,
  FEES_KV_KEY,
  FEES_LAST_GOOD_KV_KEY,
  FEES_LAST_GOOD_TTL,
  MEMPOOL_BLOCKS_URL,
  handleFees,
  isValidMempoolBlocks,
} from "../../src/handlers/fees";
import type { Env } from "../../src/lib/types";
// Captured once from mempool.space, 2026-11-17T18:20:10Z (sidecar .meta.json
// beside it); sha256 7f190af8…c74f7af0. 8 blocks; feeRange lengths 7 and 11.
import FIXTURE from "../fixtures/mempool-blocks-20261117T182010Z.json";

type Put = { key: string; value: string; ttl: number | undefined };

// A KV that records every put with its TTL, so the tests can assert what was
// (and was not) written, not only what was served.
function mockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: Put[] = [];
  const kv = {
    store,
    puts,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      puts.push({ key, value, ttl: opts?.expirationTtl });
      store.set(key, value);
    },
  };
  return kv;
}

function envWith(kv: ReturnType<typeof mockKV>): Env {
  return { PRICES_CACHE: kv as unknown as KVNamespace } as unknown as Env;
}

const LAST_GOOD_BODY = JSON.stringify({
  fetched_at: "2026-11-17T18:00:00.000Z",
  blocks: [{ medianFee: 7.5, feeRange: [7, 8] }],
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

function upstreamReturns(body: unknown, status = 200) {
  fetchSpy.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  upstreamReturns(FIXTURE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/fees — the four X-Fee-Source values", () => {
  it("live: a valid upstream response is served, cached 5 min and kept as last-good 30 min", async () => {
    const kv = mockKV();
    const res = await handleFees(envWith(kv));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Fee-Source")).toBe("live");
    const body = (await res.json()) as { fetched_at: string; blocks: unknown };
    expect(body.blocks).toEqual(FIXTURE);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(MEMPOOL_BLOCKS_URL);

    expect(kv.puts.map((p) => [p.key, p.ttl])).toEqual([
      [FEES_KV_KEY, FEES_CACHE_TTL],
      [FEES_LAST_GOOD_KV_KEY, FEES_LAST_GOOD_TTL],
    ]);
    expect(FEES_CACHE_TTL).toBe(300);
    expect(FEES_LAST_GOOD_TTL).toBe(1800);
  });

  it("cache: a second request inside the window is served from KV with no upstream fetch", async () => {
    const kv = mockKV();
    const first = await (await handleFees(envWith(kv))).text();
    const res = await handleFees(envWith(kv));

    expect(res.headers.get("X-Fee-Source")).toBe("cache");
    expect(await res.text()).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fallback: the upstream fails and the last-good value is served unchanged", async () => {
    upstreamReturns({ error: "down" }, 503);
    const kv = mockKV({ [FEES_LAST_GOOD_KV_KEY]: LAST_GOOD_BODY });
    const res = await handleFees(envWith(kv));

    expect(res.headers.get("X-Fee-Source")).toBe("fallback");
    expect(await res.text()).toBe(LAST_GOOD_BODY);
  });

  it("fallback: a network error (fetch throws) is treated as a failed upstream", async () => {
    fetchSpy.mockImplementation(async () => { throw new TypeError("network down"); });
    const kv = mockKV({ [FEES_LAST_GOOD_KV_KEY]: LAST_GOOD_BODY });
    const res = await handleFees(envWith(kv));

    expect(res.headers.get("X-Fee-Source")).toBe("fallback");
    expect(await res.text()).toBe(LAST_GOOD_BODY);
  });

  it("none: the upstream fails and no last-good value exists", async () => {
    upstreamReturns({ error: "down" }, 500);
    const res = await handleFees(envWith(mockKV()));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Fee-Source")).toBe("none");
    expect(await res.json()).toEqual({ fetched_at: null, blocks: null });
  });
});

describe("/fees — an invalid upstream response never overwrites last-good", () => {
  const INVALID: Array<[string, unknown]> = [
    ["an object, not an array", { blocks: [] }],
    ["block 1's medianFee is 0", [{ medianFee: 0, feeRange: [] }]],
    ["block 1's medianFee is negative", [{ medianFee: -1, feeRange: [] }]],
    ["block 1's medianFee is null (how JSON carries NaN/Infinity)", [{ medianFee: null, feeRange: [] }]],
    ["block 1's medianFee is a string", [{ medianFee: "5", feeRange: [] }]],
    ["a used block is not an object", [{ medianFee: 5 }, { medianFee: 4 }, null]],
  ];

  for (const [label, payload] of INVALID) {
    it(`${label} → fallback, and neither key is written`, async () => {
      upstreamReturns(payload);
      const kv = mockKV({ [FEES_LAST_GOOD_KV_KEY]: LAST_GOOD_BODY });
      const res = await handleFees(envWith(kv));

      expect(res.headers.get("X-Fee-Source")).toBe("fallback");
      expect(await res.text()).toBe(LAST_GOOD_BODY);
      expect(kv.puts).toEqual([]);
      expect(kv.store.get(FEES_LAST_GOOD_KV_KEY)).toBe(LAST_GOOD_BODY);
    });
  }
});

describe("/fees — the body carries fetched_at, the original fetch time", () => {
  it("fetched_at is the live fetch's time, and the cached copy keeps it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
      const kv = mockKV();
      const live = (await (await handleFees(envWith(kv))).json()) as { fetched_at: string };
      expect(live.fetched_at).toBe("2026-11-18T12:00:00.000Z");

      vi.setSystemTime(new Date("2026-11-18T12:04:00.000Z"));
      const cached = (await (await handleFees(envWith(kv))).json()) as { fetched_at: string };
      expect(cached.fetched_at).toBe("2026-11-18T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/fees — validity (D5; spec §3 F7, §13 item 14)", () => {
  it("the captured fixture is valid", () => {
    expect(isValidMempoolBlocks(FIXTURE)).toBe(true);
  });

  it("an empty array is valid (no backlog) and is cached live", async () => {
    upstreamReturns([]);
    const kv = mockKV({ [FEES_LAST_GOOD_KV_KEY]: LAST_GOOD_BODY });
    const res = await handleFees(envWith(kv));

    expect(res.headers.get("X-Fee-Source")).toBe("live");
    expect(((await res.json()) as { blocks: unknown }).blocks).toEqual([]);
    expect(kv.store.get(FEES_LAST_GOOD_KV_KEY)).not.toBe(LAST_GOOD_BODY);
  });

  it("feeRange may be any length, including empty or absent: the parser does not read it", () => {
    const blocks = [0, 7, 9, 11, 1, 3].map((n) => ({ medianFee: 2, feeRange: Array(n).fill(2) }));
    expect(isValidMempoolBlocks(blocks)).toBe(true);
    expect(isValidMempoolBlocks([{ medianFee: 2 }])).toBe(true);
  });

  it("an unused block may be anything; a used block may not", () => {
    // 8 blocks: indexes 0, 2 and 5 are used. Index 1 is not.
    const ok = FIXTURE.map((b) => ({ ...b }));
    (ok[1] as { medianFee: unknown }).medianFee = null;
    expect(isValidMempoolBlocks(ok)).toBe(true);

    const bad = FIXTURE.map((b) => ({ ...b }));
    (bad[5] as { medianFee: unknown }).medianFee = null;
    expect(isValidMempoolBlocks(bad)).toBe(false);
  });

  it("with fewer than 6 blocks, the last present block stands in for the missing ones and must be valid", () => {
    expect(isValidMempoolBlocks([{ medianFee: 3 }, { medianFee: 2 }])).toBe(true);
    expect(isValidMempoolBlocks([{ medianFee: 3 }, { medianFee: 0 }])).toBe(false);
  });
});

describe("/fees — routing", () => {
  it("is public: GET /fees with no Authorization header reaches the handler", async () => {
    const kv = mockKV();
    const res = await worker.fetch(new Request("https://worker.test/fees"), envWith(kv));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Fee-Source")).toBe("live");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
