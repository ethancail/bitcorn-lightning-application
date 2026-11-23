import type Database from "better-sqlite3";

// The Kraken nonce: one process-wide, serialized, strictly increasing source
// that survives a restart and a clock stepped backwards (kraken-autobuy spec
// §4 "Nonce", Ethan's ruling K2).
//
// Kraken requires each request's nonce to exceed the previous one signed with
// the same key, and the setup guidance asks for no nonce window (E5). Two
// rules follow:
//   · STRICTLY INCREASING: next = max(now in ms, last + 1). A frozen or
//     backwards clock still advances by at least 1.
//   · SERIALIZED: a nonce is issued only inside run(), which also holds the
//     request that carries it until that request finishes. Requests therefore
//     reach Kraken in nonce order; two in flight at once could arrive 6-then-5
//     and the 5 would be refused. Both the /0 and the /funding/v1 APIs go
//     through the same source, as Kraken's own helper shares one counter.
//
// SURVIVES A RESTART: the high-water mark is saved to the store BEFORE the
// nonce is handed out, so a crash after a request was sent cannot reissue it,
// and a clock stepped backwards across a restart still starts above it.

export interface NonceStore {
  /** The last nonce issued, or null when none has been. */
  load(): bigint | null;
  save(nonce: bigint): void;
}

export interface NonceSource {
  /**
   * Run `fn` with the next nonce, after every earlier run has finished. The
   * nonce is persisted before `fn` starts. Rejects, without calling `fn`, if
   * the store fails.
   */
  run<T>(fn: (nonce: string) => Promise<T>): Promise<T>;
}

export function createNonceSource(store: NonceStore, nowMs: () => number = Date.now): NonceSource {
  let last: bigint | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  function issue(): bigint {
    if (last === null) last = store.load() ?? 0n;
    const now = BigInt(Math.floor(nowMs()));
    const next = now > last ? now : last + 1n;
    store.save(next); // persist first: a nonce is never handed out unsaved
    last = next;
    return next;
  }

  return {
    run<T>(fn: (nonce: string) => Promise<T>): Promise<T> {
      const p = tail.then(() => fn(issue().toString()));
      tail = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}

/** The high-water mark in kraken_nonce (migration 089): one row, id 1. */
export function dbNonceStore(db: Database.Database): NonceStore {
  return {
    load() {
      const row = db.prepare(`SELECT last_nonce FROM kraken_nonce WHERE id = 1`).get() as { last_nonce: string } | undefined;
      return row ? BigInt(row.last_nonce) : null;
    },
    save(nonce) {
      db.prepare(
        `INSERT INTO kraken_nonce (id, last_nonce) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_nonce = excluded.last_nonce`,
      ).run(nonce.toString());
    },
  };
}

let processSource: NonceSource | null = null;

/**
 * The process-wide source over the node's database. Every Kraken request in
 * the process must use this one; the first call creates it and later calls
 * return the same source.
 */
export function krakenNonceSource(db: Database.Database): NonceSource {
  if (!processSource) processSource = createNonceSource(dbNonceStore(db));
  return processSource;
}
