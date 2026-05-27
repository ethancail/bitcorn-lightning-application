import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_CHANGED_EVENT,
  addPendingEntry,
  getPendingEntries,
  markPendingFailed,
  reconcileAgainstSettled,
  removePendingEntry,
  type PendingEntry,
} from "./pendingStore";

// First unit-test target for the web container (vitest + jsdom). pendingStore
// is the localStorage adapter behind the Pending-settlement UI; these tests
// lock down the behaviors that the Day-2 testnet pass found mattered —
// especially the cross-component change broadcast (Bug B), the per-member
// namespacing (architectural decision-1), and the confirm-reconcile sweep.

const MEMBER_A =
  "03b2c3df7d60cd289a79aea1913dccfacbf0c133a7748fef4c2c1c0fb513ddc052";
const MEMBER_B =
  "0362c94fb8d623ecc7c6f67f6c78ba0f404082fb13cf413ca2e9e28e9237e5eeec";

const TX_1 =
  "0xabc0000000000000000000000000000000000000000000000000000000000001" as const;
const TX_2 =
  "0xdef0000000000000000000000000000000000000000000000000000000000002" as const;

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    tx_hash: TX_1,
    submitted_at: 1000,
    recipient_address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    amount_human: "0.10",
    amount_units_raw: "100000",
    rpc_url: null,
    status: "submitted",
    ...overrides,
  };
}

let listeners: Array<() => void> = [];
function onPendingChanged(fn: () => void): void {
  const handler = () => fn();
  window.addEventListener(PENDING_CHANGED_EVENT, handler);
  listeners.push(() => window.removeEventListener(PENDING_CHANGED_EVENT, handler));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  listeners.forEach((off) => off());
  listeners = [];
});

describe("pendingStore — read/write roundtrip", () => {
  it("returns [] when nothing is stored", () => {
    expect(getPendingEntries(MEMBER_A)).toEqual([]);
  });

  it("adds an entry and reads it back", () => {
    addPendingEntry(MEMBER_A, entry());
    const got = getPendingEntries(MEMBER_A);
    expect(got).toHaveLength(1);
    expect(got[0].tx_hash).toBe(TX_1);
    expect(got[0].status).toBe("submitted");
  });

  it("dedupes by tx_hash — re-adding the same hash replaces, not duplicates", () => {
    addPendingEntry(MEMBER_A, entry({ amount_human: "0.10" }));
    addPendingEntry(MEMBER_A, entry({ amount_human: "0.20" }));
    const got = getPendingEntries(MEMBER_A);
    expect(got).toHaveLength(1);
    expect(got[0].amount_human).toBe("0.20"); // latest wins
  });
});

describe("pendingStore — per-member namespacing (decision-1)", () => {
  it("does not leak entries across member pubkeys", () => {
    addPendingEntry(MEMBER_A, entry());
    expect(getPendingEntries(MEMBER_A)).toHaveLength(1);
    expect(getPendingEntries(MEMBER_B)).toHaveLength(0);
  });

  it("namespaces case-insensitively (pubkey lowercased in the key)", () => {
    addPendingEntry(MEMBER_A.toUpperCase(), entry());
    // Stored under the lowercased key, so the lowercase pubkey reads it back.
    expect(getPendingEntries(MEMBER_A)).toHaveLength(1);
  });
});

describe("pendingStore — change broadcast (Bug B regression)", () => {
  it("broadcasts on addPendingEntry so a sibling reader can re-read", () => {
    const fn = vi.fn();
    onPendingChanged(fn);
    addPendingEntry(MEMBER_A, entry());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("broadcasts on removePendingEntry when something is removed", () => {
    addPendingEntry(MEMBER_A, entry());
    const fn = vi.fn();
    onPendingChanged(fn);
    removePendingEntry(MEMBER_A, TX_1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getPendingEntries(MEMBER_A)).toHaveLength(0);
  });

  it("does NOT broadcast on a no-op remove (tx_hash not present)", () => {
    addPendingEntry(MEMBER_A, entry());
    const fn = vi.fn();
    onPendingChanged(fn);
    removePendingEntry(MEMBER_A, TX_2); // not present
    expect(fn).not.toHaveBeenCalled();
    expect(getPendingEntries(MEMBER_A)).toHaveLength(1);
  });

  it("broadcasts on markPendingFailed", () => {
    addPendingEntry(MEMBER_A, entry());
    const fn = vi.fn();
    onPendingChanged(fn);
    markPendingFailed(MEMBER_A, TX_1, "Transaction reverted on-chain");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("pendingStore — markPendingFailed", () => {
  it("sets status=failed and records the revert reason", () => {
    addPendingEntry(MEMBER_A, entry());
    markPendingFailed(MEMBER_A, TX_1, "insufficient allowance");
    const got = getPendingEntries(MEMBER_A);
    expect(got[0].status).toBe("failed");
    expect(got[0].revert_reason).toBe("insufficient allowance");
  });
});

describe("pendingStore — reconcileAgainstSettled (exit condition (a))", () => {
  it("removes entries whose tx_hash is in the settled set and reports the count", () => {
    addPendingEntry(MEMBER_A, entry({ tx_hash: TX_1 }));
    addPendingEntry(MEMBER_A, entry({ tx_hash: TX_2 }));
    const { removed } = reconcileAgainstSettled(MEMBER_A, new Set([TX_1]));
    expect(removed).toBe(1);
    const survivors = getPendingEntries(MEMBER_A);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].tx_hash).toBe(TX_2);
  });

  it("matches case-insensitively (entry hash lowercased vs the lowercase set)", () => {
    // The settled set is built lowercased by the caller; a mixed-case entry
    // hash must still match.
    const mixed = ("0xABCDEF0000000000000000000000000000000000000000000000000000000003" as `0x${string}`);
    addPendingEntry(MEMBER_A, entry({ tx_hash: mixed }));
    const { removed } = reconcileAgainstSettled(
      MEMBER_A,
      new Set([mixed.toLowerCase()]),
    );
    expect(removed).toBe(1);
    expect(getPendingEntries(MEMBER_A)).toHaveLength(0);
  });

  it("is a no-op (removed 0) when nothing matches", () => {
    addPendingEntry(MEMBER_A, entry({ tx_hash: TX_1 }));
    const { removed } = reconcileAgainstSettled(MEMBER_A, new Set([TX_2]));
    expect(removed).toBe(0);
    expect(getPendingEntries(MEMBER_A)).toHaveLength(1);
  });
});

describe("pendingStore — safeParse robustness", () => {
  it("returns [] for malformed JSON rather than throwing", () => {
    localStorage.setItem(`bitcorn:stablecoin:pending:${MEMBER_A}`, "{not json");
    expect(getPendingEntries(MEMBER_A)).toEqual([]);
  });

  it("returns [] when the stored value is not an array", () => {
    localStorage.setItem(`bitcorn:stablecoin:pending:${MEMBER_A}`, '{"a":1}');
    expect(getPendingEntries(MEMBER_A)).toEqual([]);
  });

  it("filters out entries with an invalid shape", () => {
    const valid = entry();
    const invalid = { tx_hash: "0xbad", submitted_at: "not-a-number" };
    localStorage.setItem(
      `bitcorn:stablecoin:pending:${MEMBER_A}`,
      JSON.stringify([valid, invalid]),
    );
    const got = getPendingEntries(MEMBER_A);
    expect(got).toHaveLength(1);
    expect(got[0].tx_hash).toBe(TX_1);
  });
});
