// Pending-settlement localStorage adapter.
//
// Spec amendment §4 — frontend-only Pending state with persistent storage
// for cross-session visibility. The frontend is the source of truth for
// "is this settlement Pending?" until one of three exits resolves it:
//   (a) the corresponding Settled event appears in /settlements (match by
//       tx_hash) — entry deleted, list shows the now-Confirmed row;
//   (b) eth_getTransactionReceipt returns status=0 (reverted) — entry's
//       status moves to "failed" and the user sees Dismiss;
//   (c) user manually dismisses.
//
// Storage layout: one key per member pubkey, namespaced as
//   bitcorn:stablecoin:pending:<lowercase-member-pubkey>
// Per the user's architectural decision-1: namespace by member pubkey so
// multiple members on the same browser (e.g., a dev switching .env files)
// don't see each other's Pending entries.

const KEY_PREFIX = "bitcorn:stablecoin:pending:";

/**
 * Window event broadcast on every Pending-store mutation. The settlement
 * form (writer) and the history list (reader) are sibling components that
 * share state only through localStorage; without a signal, the list reads
 * its Pending entries once on mount and never sees a newly-submitted one
 * until a confirm-reconcile happens to sweep it away — so the Pending row
 * never renders during the in-flight window. The list subscribes to this
 * event and re-reads. Mirrors the existing `bitcorn:stablecoin-wallet-changed`
 * cross-component pattern.
 */
export const PENDING_CHANGED_EVENT = "bitcorn:stablecoin-pending-changed";

function broadcastPendingChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PENDING_CHANGED_EVENT));
  }
}

export interface PendingEntry {
  tx_hash: `0x${string}`;
  submitted_at: number;
  recipient_address: `0x${string}`;
  amount_human: string;
  amount_units_raw: string;
  /**
   * The wallet's RPC URL that submitted the tx. Used by the
   * reverted-tx detection path (§4 (b)) — `eth_getTransactionReceipt`
   * polls go through this RPC, not Bitcorn's. Null when the connector
   * didn't expose an RPC (e.g., a WalletConnect session that ended).
   */
  rpc_url: string | null;
  /** v1 Pending lives in a single "submitted" state until one of the
   *  three exits fires; "failed" is the transient state between
   *  receipt-status-0 detection and the user's Dismiss confirmation. */
  status: "submitted" | "failed";
  /** Populated when status flips to "failed" — surfaced in the row's
   *  "Failed: <reason>" copy. */
  revert_reason?: string;
}

function keyFor(memberPubkey: string): string {
  return KEY_PREFIX + memberPubkey.toLowerCase();
}

function safeParse(raw: string | null): PendingEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingEntry);
  } catch {
    return [];
  }
}

function isPendingEntry(v: unknown): v is PendingEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.tx_hash === "string" &&
    e.tx_hash.startsWith("0x") &&
    typeof e.submitted_at === "number" &&
    typeof e.recipient_address === "string" &&
    typeof e.amount_human === "string" &&
    typeof e.amount_units_raw === "string" &&
    (e.rpc_url === null || typeof e.rpc_url === "string") &&
    (e.status === "submitted" || e.status === "failed")
  );
}

export function getPendingEntries(memberPubkey: string): PendingEntry[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(keyFor(memberPubkey)));
}

export function addPendingEntry(
  memberPubkey: string,
  entry: PendingEntry,
): void {
  const entries = getPendingEntries(memberPubkey);
  // Dedupe by tx_hash — re-submitting a tx with the same hash is a no-op.
  const filtered = entries.filter((e) => e.tx_hash !== entry.tx_hash);
  filtered.push(entry);
  localStorage.setItem(keyFor(memberPubkey), JSON.stringify(filtered));
  broadcastPendingChanged();
}

export function removePendingEntry(
  memberPubkey: string,
  txHash: `0x${string}`,
): void {
  const entries = getPendingEntries(memberPubkey);
  const filtered = entries.filter((e) => e.tx_hash !== txHash);
  if (filtered.length === entries.length) return;
  localStorage.setItem(keyFor(memberPubkey), JSON.stringify(filtered));
  broadcastPendingChanged();
}

export function markPendingFailed(
  memberPubkey: string,
  txHash: `0x${string}`,
  revertReason: string,
): void {
  const entries = getPendingEntries(memberPubkey);
  const updated = entries.map((e) =>
    e.tx_hash === txHash ? { ...e, status: "failed" as const, revert_reason: revertReason } : e,
  );
  localStorage.setItem(keyFor(memberPubkey), JSON.stringify(updated));
  broadcastPendingChanged();
}

/**
 * Garbage-collect entries whose tx_hash matches any settled event already
 * surfaced by /settlements. Called by the polling loop on each refresh —
 * the spec amendment's exit (a) condition.
 */
export function reconcileAgainstSettled(
  memberPubkey: string,
  settledTxHashes: ReadonlySet<string>,
): { removed: number } {
  const entries = getPendingEntries(memberPubkey);
  const survivors = entries.filter(
    (e) => !settledTxHashes.has(e.tx_hash.toLowerCase()),
  );
  if (survivors.length === entries.length) return { removed: 0 };
  localStorage.setItem(keyFor(memberPubkey), JSON.stringify(survivors));
  return { removed: entries.length - survivors.length };
}
