// SettlementHistoryList — paginated history + Pending overlay.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8.4, §9.1
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §3, §4
//
// Row layout (§3):
//   [direction icon]  [counterparty]    [amount]      [block N ↗]
//                                       [Fee: X if nonzero]
//
// Pending rows render at the top with a "Pending" pill and update in
// place once the Settled event lands (§4: "the UI does not pop a new
// row at the top while the old Pending row remains").
//
// Counterparty name resolution at v1 — falls back to truncated address.
// Spec §3 contemplates joining against member_base_wallet + member
// identity for name resolution; the API doesn't surface that today, so
// truncated-address-only is the v1 behavior. Flag as a follow-up.
//
// Reverted-tx detection (§4 (b)) runs through wagmi's publicClient. For
// each Pending entry, every 30s we call getTransactionReceipt and check
// receipt.status === 'reverted'. Cadence chosen to keep RPC load
// reasonable while still surfacing reverts within a 30-second worst-case
// window. Captured here so future implementers understand the trade-off
// (spec amendment §10's "deltas-record-worthy cadence choice").

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { stablecoinApi, type SettlementRow } from "../client";
import {
  getPendingEntries,
  markPendingFailed,
  reconcileAgainstSettled,
  removePendingEntry,
  type PendingEntry,
} from "../pendingStore";
import { basescanBlockUrl, basescanTxUrl } from "../contract";
import ColdStartSpinner from "./ColdStartSpinner";
import EmptyState from "./EmptyState";

const REFRESH_INTERVAL_MS = 15_000;
const REVERT_POLL_INTERVAL_MS = 30_000;

type View =
  | { kind: "loading" }
  | { kind: "loaded"; rows: SettlementRow[] }
  | { kind: "error"; detail?: string };

interface Props {
  memberPubkey: string;
  walletAddress: string;
  chainId: number;
  onSendClick: () => void;
}

export default function SettlementHistoryList({
  memberPubkey,
  walletAddress,
  chainId,
  onSendClick,
}: Props) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pending, setPending] = useState<PendingEntry[]>(() => getPendingEntries(memberPubkey));
  const [expandedTxHash, setExpandedTxHash] = useState<string | null>(null);
  const publicClient = usePublicClient();

  const refreshPending = useCallback(() => {
    setPending(getPendingEntries(memberPubkey));
  }, [memberPubkey]);

  const fetchHistory = useCallback(async () => {
    try {
      const resp = await stablecoinApi.getSettlements({ limit: 50 });
      setView({ kind: "loaded", rows: resp.settlements });

      // Reconcile Pending vs Settled on every refresh — exit condition
      // (a) per spec amendment §4.
      const settledSet = new Set(
        resp.settlements.map((r) => r.tx_hash.toLowerCase()),
      );
      const { removed } = reconcileAgainstSettled(memberPubkey, settledSet);
      if (removed > 0) refreshPending();
    } catch (err) {
      const e = err as { detail?: string; message?: string };
      setView({ kind: "error", detail: e.detail ?? e.message });
    }
  }, [memberPubkey, refreshPending]);

  useEffect(() => {
    void fetchHistory();
    const id = setInterval(() => void fetchHistory(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchHistory]);

  // Reverted-tx detection — for each Pending entry, poll receipt every 30s.
  // Stop polling once the entry is removed or marked failed.
  useEffect(() => {
    if (!publicClient || pending.length === 0) return;
    let cancelled = false;
    const checkAll = async () => {
      for (const entry of pending) {
        if (entry.status === "failed") continue;
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: entry.tx_hash });
          if (cancelled) return;
          if (receipt && receipt.status === "reverted") {
            markPendingFailed(memberPubkey, entry.tx_hash, "Transaction reverted on-chain");
            refreshPending();
          }
        } catch {
          // Not yet mined OR RPC hiccup; either way we'll retry on the
          // next interval.
        }
      }
    };
    const id = setInterval(() => void checkAll(), REVERT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [memberPubkey, pending, publicClient, refreshPending]);

  const handleDismissPending = useCallback(
    (txHash: `0x${string}`) => {
      removePendingEntry(memberPubkey, txHash);
      refreshPending();
    },
    [memberPubkey, refreshPending],
  );

  const sortedPending = useMemo(
    () => [...pending].sort((a, b) => b.submitted_at - a.submitted_at),
    [pending],
  );

  if (view.kind === "loading") {
    return <ColdStartSpinner />;
  }

  if (view.kind === "error") {
    return (
      <div className="sub-alert sub-alert-dim-red stablecoin-banner">
        <span className="sub-alert-icon" aria-hidden>✕</span>
        <div className="sub-alert-body">
          Couldn't load settlement history.
          {view.detail ? <span className="sub-error-detail"> ({view.detail})</span> : null}
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-outline btn-sm" onClick={() => void fetchHistory()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  const totalRows = sortedPending.length + view.rows.length;
  if (totalRows === 0) {
    // Truly empty: no confirmed settlements AND no Pending entries.
    // Rendered here (rather than the parent) so a Pending row submitted
    // while the list is otherwise empty still shows — and so the list
    // stays mounted + polling, picking up the settlement when it
    // confirms instead of being stuck on the empty state.
    return <EmptyState walletAddress={walletAddress} onSend={onSendClick} />;
  }

  return (
    <div className="stablecoin-history">
      <div className="stablecoin-history-header">
        <h3 className="stablecoin-history-title">Recent settlements</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => void fetchHistory()}>
          Refresh
        </button>
      </div>
      <ul className="stablecoin-history-list">
        {sortedPending.map((entry) => (
          <PendingRow
            key={entry.tx_hash}
            entry={entry}
            chainId={chainId}
            onDismiss={() => handleDismissPending(entry.tx_hash)}
          />
        ))}
        {view.rows.map((row) => (
          <SettledRow
            key={`${row.tx_hash}-${row.log_index}`}
            row={row}
            walletAddress={walletAddress}
            chainId={chainId}
            expanded={expandedTxHash === row.tx_hash}
            onToggle={() =>
              setExpandedTxHash((prev) => (prev === row.tx_hash ? null : row.tx_hash))
            }
          />
        ))}
      </ul>
    </div>
  );
}

// ─── Pending row ────────────────────────────────────────────────────────

function PendingRow({
  entry,
  chainId,
  onDismiss,
}: {
  entry: PendingEntry;
  chainId: number;
  onDismiss: () => void;
}) {
  const ageSec = Math.floor((Date.now() - entry.submitted_at) / 1000);
  const ageLabel =
    ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
      ? `${Math.floor(ageSec / 60)}m ago`
      : `${Math.floor(ageSec / 3600)}h ago`;
  const isFailed = entry.status === "failed";
  return (
    <li className={`stablecoin-row stablecoin-row-pending ${isFailed ? "stablecoin-row-failed" : ""}`}>
      <div className="stablecoin-row-main">
        <span className={`stablecoin-pill ${isFailed ? "stablecoin-pill-failed" : "stablecoin-pill-pending"}`}>
          {isFailed ? "Failed" : "Pending"}
        </span>
        <span className="stablecoin-row-direction">→</span>
        <code className="stablecoin-row-address">{truncate(entry.recipient_address)}</code>
        <span className="stablecoin-row-amount">{entry.amount_human} USDC</span>
        <a
          className="stablecoin-row-link"
          href={basescanTxUrl(chainId, entry.tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          title="View on BaseScan"
        >
          tx ↗
        </a>
      </div>
      <div className="stablecoin-row-secondary">
        <span>{isFailed ? entry.revert_reason ?? "Transaction reverted" : `Submitted ${ageLabel} — waiting for confirmation`}</span>
        <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

// ─── Settled row ────────────────────────────────────────────────────────

function SettledRow({
  row,
  walletAddress: _walletAddress,
  chainId,
  expanded,
  onToggle,
}: {
  row: SettlementRow;
  walletAddress: string;
  chainId: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const counterparty =
    row.direction === "sent" ? row.recipient_address : row.sender_address;
  const directionGlyph = row.direction === "sent" ? "→" : "←";
  const directionLabel = row.direction === "sent" ? "Sent" : "Received";
  const feeUnits = BigInt(row.fee_units_raw);
  const hasFee = feeUnits > 0n;
  const syncedAt = new Date(row.discovered_at);
  return (
    <li className={`stablecoin-row stablecoin-row-settled ${expanded ? "stablecoin-row-expanded" : ""}`}>
      <button type="button" className="stablecoin-row-main" onClick={onToggle}>
        <span className={`stablecoin-pill stablecoin-pill-${row.direction}`}>{directionLabel}</span>
        <span className="stablecoin-row-direction">{directionGlyph}</span>
        <code className="stablecoin-row-address">{truncate(counterparty)}</code>
        <span className="stablecoin-row-amount">{row.amount_human} USDC</span>
        <a
          className="stablecoin-row-link"
          href={basescanBlockUrl(chainId, row.block_number)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="View block on BaseScan"
        >
          Block {row.block_number.toLocaleString()} ↗
        </a>
      </button>
      {hasFee && (
        <div className="stablecoin-row-fee-inline">
          Fee: {row.fee_human} USDC
        </div>
      )}
      {expanded && (
        <div className="stablecoin-row-detail">
          <DetailRow label="Transaction">
            <a
              href={basescanTxUrl(chainId, row.tx_hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="stablecoin-row-link"
            >
              {row.tx_hash} ↗
            </a>
          </DetailRow>
          <DetailRow label="Counterparty">
            <code>{counterparty}</code>
          </DetailRow>
          <DetailRow label="Amount">{row.amount_human} USDC</DetailRow>
          <DetailRow label="Fee">
            {row.fee_human} USDC <span className="stablecoin-fee-rate">(historical)</span>
          </DetailRow>
          <DetailRow label="Reference">
            <code>{row.trade_ref}</code>
          </DetailRow>
          <DetailRow label="Synced">
            <span title="Bitcorn observed this settlement at this time; the on-chain settlement happened in the named block.">
              {syncedAt.toLocaleString()} — sync clock, not block time
            </span>
          </DetailRow>
        </div>
      )}
    </li>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stablecoin-detail-row">
      <span className="stablecoin-detail-label">{label}</span>
      <span className="stablecoin-detail-value">{children}</span>
    </div>
  );
}

function truncate(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
