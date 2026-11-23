// kraken-autobuy P3: the Kraken nonce source (spec §3 P3 done-when "nonces
// strictly increase", §4 "Nonce", Ethan's ruling K2).
//
// Every case drives createNonceSource with an injected clock and an in-memory
// store, except T7, which runs the real dbNonceStore against migration 089's
// own SQL. "Strictly increasing" is asserted with BigInt comparisons over the
// nonces in the order the runs actually STARTED, which is the order Kraken
// would receive them.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createNonceSource, dbNonceStore, krakenNonceSource, type NonceStore } from "./krakenNonce";

function memStore(initial: bigint | null = null): NonceStore & { value: bigint | null; saves: bigint[] } {
  const s = {
    value: initial,
    saves: [] as bigint[],
    load: () => s.value,
    save: (n: bigint) => { s.value = n; s.saves.push(n); },
  };
  return s;
}

function strictlyIncreasing(xs: bigint[]): boolean {
  return xs.every((x, i) => i === 0 || x > xs[i - 1]);
}

const T = 1_894_017_600_000; // ms

describe("Kraken nonce source", () => {
  it("T1 a frozen clock: 50 sequential runs still give strictly increasing nonces", async () => {
    const src = createNonceSource(memStore(), () => T);
    const seen: bigint[] = [];
    for (let i = 0; i < 50; i++) seen.push(BigInt(await src.run(async (n) => n)));
    expect(strictlyIncreasing(seen)).toBe(true);
    expect(seen[0]).toBe(BigInt(T));
    expect(seen[49]).toBe(BigInt(T) + 49n);
  });

  it("T2 a clock stepped back an hour mid-run: still strictly increasing", async () => {
    let now = T;
    const src = createNonceSource(memStore(), () => now);
    const seen: bigint[] = [];
    for (let i = 0; i < 10; i++) { seen.push(BigInt(await src.run(async (n) => n))); now += 7; }
    now -= 3_600_000;
    for (let i = 0; i < 10; i++) seen.push(BigInt(await src.run(async (n) => n)));
    expect(strictlyIncreasing(seen)).toBe(true);
  });

  it("T3 a restart over a store whose mark is ABOVE the clock (the clock went back across the restart): the first nonce exceeds the mark", async () => {
    const store = memStore();
    const before = createNonceSource(store, () => T + 5_000);
    for (let i = 0; i < 3; i++) await before.run(async (n) => n);
    const mark = store.value!;
    const after = createNonceSource(store, () => T - 86_400_000); // a fresh process, clock a day behind
    expect(BigInt(await after.run(async (n) => n))).toBe(mark + 1n);
  });

  it("T4 the nonce is saved BEFORE the request runs: inside run(), the store already holds it", async () => {
    const store = memStore();
    const src = createNonceSource(store, () => T);
    for (let i = 0; i < 5; i++) {
      await src.run(async (n) => { expect(store.value).toBe(BigInt(n)); });
    }
  });

  it("T5 100 concurrent runs with random delays: one in flight at a time, nonces strictly increasing in the order the runs started", async () => {
    const src = createNonceSource(memStore(), () => T); // frozen clock: ordering can come only from the source
    let inFlight = 0;
    let maxInFlight = 0;
    const started: bigint[] = [];
    await Promise.all(Array.from({ length: 100 }, () =>
      src.run(async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(BigInt(n));
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        inFlight--;
      }),
    ));
    expect(started).toHaveLength(100);
    expect(maxInFlight).toBe(1);
    expect(strictlyIncreasing(started)).toBe(true);
  });

  it("T6 a failed run does not stall the queue, and a store failure refuses the run without calling it", async () => {
    const store = memStore();
    const src = createNonceSource(store, () => T);
    await expect(src.run(async () => { throw new Error("request failed"); })).rejects.toThrow("request failed");
    expect(await src.run(async (n) => n)).toBe(String(T + 1));

    const failing: NonceStore = { load: () => null, save: () => { throw new Error("disk full"); } };
    const broken = createNonceSource(failing, () => T);
    let called = false;
    await expect(broken.run(async () => { called = true; })).rejects.toThrow("disk full");
    expect(called).toBe(false);
  });

  it("T7 dbNonceStore on migration 089's table: empty reads null; a save round-trips exactly, beyond 2^53", () => {
    const db = new Database(":memory:");
    db.exec(fs.readFileSync(path.join(__dirname, "../db/migrations/089_kraken_nonce.sql"), "utf8"));
    const store = dbNonceStore(db);
    expect(store.load()).toBeNull();
    store.save(1_894_017_600_123n);
    expect(store.load()).toBe(1_894_017_600_123n);
    const big = 18_446_744_073_709_551_615n;
    store.save(big);
    expect(store.load()).toBe(big);
    expect(db.prepare("SELECT COUNT(*) AS n FROM kraken_nonce").get()).toEqual({ n: 1 });
    db.close();
  });

  it("T8 krakenNonceSource is one source per process", () => {
    const db = new Database(":memory:");
    expect(krakenNonceSource(db)).toBe(krakenNonceSource(db));
    db.close();
  });
});
