// Stablecoin Settlements page — member-side surface.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §9.1
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md
//
// Four panels per §9.1:
//   1. Wallet Status   — address + balance + "Manage in Settings" link
//   2. Send USDC       — settlement form (collapsible)
//   3. Recent Settlements — history list (or EmptyState)
//   4. Contract Status — fee bps + paused + router address
//
// Cross-cutting overlays:
//   - StaleBanner       (spec amendment §7 — 3 / 15 min thresholds)
//   - RailErrorBanner   (spec amendment §9 — three failure classes)
//   - ColdStartSpinner  (spec amendment §10 — initial cold-start UX)
//
// JWT auth note: the spec amendment's §9 "JWT authentication failure"
// surfaces here as a 502/503 from the API container when the
// API↔Worker JWT pairing breaks. The frontend itself does not carry a
// bearer token — local-network trust via CORS at the API. The mapping
// from upstream errors to the three RailErrorBanner variants happens
// in classifyError() below.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  stablecoinApi,
  type BalanceResponse,
  type ContractStateResponse,
  type SyncCursorResponse,
  type WalletStatusResponse,
} from "../stablecoin/client";
import { api, type NodeInfo } from "../api/client";
import RailErrorBanner, { type RailErrorKind } from "../stablecoin/components/RailErrorBanner";
import StaleBanner from "../stablecoin/components/StaleBanner";
import SettlementForm from "../stablecoin/components/SettlementForm";
import SettlementHistoryList from "../stablecoin/components/SettlementHistoryList";
import { basescanAddressUrl } from "../stablecoin/contract";

const POLL_INTERVAL_MS = 15_000;

function classifyError(err: unknown): RailErrorKind | null {
  const e = err as { status?: number; code?: string; message?: string };
  if (e?.status === undefined) {
    // Network-level fetch failure (TypeError "Failed to fetch", etc.)
    return "network_unreachable";
  }
  if (e.status === 502 || e.code === "upstream_error" || e.code === "worker_unreachable") {
    // API container reached the Worker but the Worker → BASE RPC failed.
    return "upstream_rpc";
  }
  if (e.status === 503 || e.status === 401 || e.code === "auth_failure" || e.code === "node_not_ready") {
    // The API container can't authenticate to the Worker (or LND isn't
    // ready yet); the spec amendment groups these as the "auth failure
    // after retry" variant.
    return "auth_failure";
  }
  return null;
}

// MemberShell wraps with RailScope (WagmiProvider + QueryClientProvider)
// — see App.tsx note. This page assumes those providers are in scope.
export default function Stablecoin() {
  const [walletStatus, setWalletStatus] = useState<WalletStatusResponse | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [contractState, setContractState] = useState<ContractStateResponse | null>(null);
  const [cursor, setCursor] = useState<SyncCursorResponse | null>(null);
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [errorKind, setErrorKind] = useState<RailErrorKind | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);

  // Load local node identity once (member pubkey is the localStorage key
  // namespace for the Pending store, per architectural decision-1).
  useEffect(() => {
    let cancelled = false;
    void api.getNode().then((n) => { if (!cancelled) setNode(n); }).catch(() => { /* leave null */ });
    return () => { cancelled = true; };
  }, []);

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled([
      stablecoinApi.getWalletStatus(),
      stablecoinApi.getContractState(),
      stablecoinApi.getSyncCursor(),
    ]);

    // Surface the worst error class encountered. If wallet-status failed
    // with auth_failure but contract-state succeeded, we still render —
    // partial data is better than nothing per spec amendment §9's
    // distinction between "Bitcorn is observing" (degraded) and "Bitcorn
    // is offline" (unreachable).
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length === results.length) {
      // All three calls failed — most likely network_unreachable or a
      // general API down. Pick the first error to classify.
      const err = errors[0].reason;
      setErrorKind(classifyError(err));
      setErrorDetail((err as { detail?: string; message?: string })?.detail ?? (err as { message?: string })?.message);
      setInitialLoadDone(true);
      return;
    }

    setErrorKind(null);
    setErrorDetail(undefined);

    const [wResult, cResult, cursorResult] = results;
    if (wResult.status === "fulfilled") setWalletStatus(wResult.value);
    if (cResult.status === "fulfilled") setContractState(cResult.value);
    if (cursorResult.status === "fulfilled") setCursor(cursorResult.value);

    // Balance only meaningful if we have a registered wallet.
    if (wResult.status === "fulfilled" && wResult.value.wallet_address && wResult.value.is_active) {
      try {
        const bal = await stablecoinApi.getBalance();
        setBalance(bal);
      } catch (err) {
        const e = err as { status?: number };
        // 404 balance_not_cached_yet during cold-start is expected for a
        // newly-registered wallet; surface as "—" rather than an error
        // banner.
        if (e.status !== 404) {
          const kind = classifyError(err);
          if (kind) setErrorKind(kind);
        }
        setBalance(null);
      }
    } else {
      setBalance(null);
    }

    setInitialLoadDone(true);
  }, []);

  useEffect(() => {
    void fetchAll();
    const id = setInterval(() => void fetchAll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  // Cross-page event: when the Settings page registers/unregisters a
  // wallet, refresh immediately rather than waiting for the next 15s tick.
  useEffect(() => {
    const onChange = () => void fetchAll();
    window.addEventListener("bitcorn:stablecoin-wallet-changed", onChange);
    return () => window.removeEventListener("bitcorn:stablecoin-wallet-changed", onChange);
  }, [fetchAll]);

  const memberPubkey = node?.pubkey ?? null;
  const hasWallet = walletStatus?.wallet_address && walletStatus.is_active;
  const chainId = parseInt(import.meta.env.VITE_BASE_CHAIN_ID ?? "84532", 10);

  return (
    <div className="page stablecoin-page">
      <header className="page-header">
        <h1>Stablecoin Settlements</h1>
        <p className="page-subtitle">
          Non-custodial USDC settlements on BASE. Bitcorn observes; your wallet signs.
        </p>
      </header>

      {errorKind === "network_unreachable" && (
        <RailErrorBanner kind="network_unreachable" detail={errorDetail} onRetry={() => void fetchAll()} />
      )}
      {errorKind === "auth_failure" && (
        <RailErrorBanner kind="auth_failure" detail={errorDetail} onRetry={() => void fetchAll()} />
      )}
      {errorKind === "upstream_rpc" && (
        <RailErrorBanner kind="upstream_rpc" detail={errorDetail} />
      )}
      <StaleBanner cursor={cursor} />

      {/* ─── Panel 1: Wallet Status ───────────────────────────────── */}
      <section className="panel ops">
        <header className="panel-header">
          <div className="panel-title">
            <span className="icon">◇</span>
            <h2>Wallet</h2>
          </div>
        </header>
        <div className="panel-body">
          {!initialLoadDone ? (
            <p className="stablecoin-loading">Loading…</p>
          ) : !hasWallet ? (
            <div className="stablecoin-no-wallet">
              <p>
                You haven't registered a BASE wallet yet. Stablecoin settlements need a wallet
                to send from and to receive into.
              </p>
              <Link to="/settings" className="btn btn-primary">
                Connect a wallet in Settings
              </Link>
            </div>
          ) : (
            <div className="stablecoin-wallet-status">
              <div className="stablecoin-wallet-row">
                <div className="stablecoin-label">ADDRESS</div>
                <a
                  className="stablecoin-row-link stablecoin-extlink"
                  href={basescanAddressUrl(chainId, walletStatus!.wallet_address!)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on BaseScan"
                >
                  <code className="stablecoin-address">{walletStatus!.wallet_address}</code>
                  <span className="stablecoin-extlink-icon" aria-hidden>↗</span>
                </a>
              </div>
              <div className="stablecoin-wallet-row">
                <div className="stablecoin-label">USDC BALANCE</div>
                <div className="stablecoin-balance">
                  {balance ? `${balance.balance_human} USDC` : "—"}
                  {balance && (
                    <span className="stablecoin-balance-staleness">
                      as of {Math.floor(balance.staleness_seconds)}s ago
                    </span>
                  )}
                </div>
              </div>
              <div className="stablecoin-actions" style={{ marginTop: 12 }}>
                <Link to="/settings" className="btn btn-outline btn-sm">Manage wallet</Link>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ─── Panel 2: Send USDC ───────────────────────────────────── */}
      {hasWallet && memberPubkey && (
        <section className="panel ops">
          <header className="panel-header">
            <div className="panel-title">
              <span className="icon">→</span>
              <h2>Send USDC</h2>
            </div>
            {!showSendForm && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowSendForm(true)}>
                New settlement
              </button>
            )}
          </header>
          {showSendForm && (
            <div className="panel-body">
              <SettlementForm
                contractState={contractState}
                memberPubkey={memberPubkey}
                onSubmitted={() => void fetchAll()}
                onClose={() => setShowSendForm(false)}
              />
            </div>
          )}
        </section>
      )}

      {/* ─── Panel 3: Recent Settlements / Empty State ─────────────── */}
      {hasWallet && memberPubkey && (
        <section className="panel ops">
          <header className="panel-header">
            <div className="panel-title">
              <span className="icon">≡</span>
              <h2>Recent settlements</h2>
            </div>
          </header>
          <div className="panel-body">
            {/* SettlementHistoryList owns the empty/loading/list decision
                itself — it's the only component that knows BOTH the
                confirmed-row count AND the localStorage Pending count.
                The page used to branch on a confirmed-only count here,
                which (a) hid Pending rows when there were no confirmed
                settlements and (b) unmounted the list once empty, so it
                stopped polling and never recovered when a settlement
                later confirmed. Keeping it always-mounted fixes both. */}
            <SettlementHistoryList
              memberPubkey={memberPubkey}
              walletAddress={walletStatus!.wallet_address!}
              chainId={chainId}
              onSendClick={() => setShowSendForm(true)}
            />
          </div>
        </section>
      )}

      {/* ─── Panel 4: Contract Status ──────────────────────────────── */}
      {contractState && (
        <section className="panel ops stablecoin-contract-strip">
          <header className="panel-header">
            <div className="panel-title">
              <span className="icon">◌</span>
              <h2>Contract Status</h2>
            </div>
          </header>
          <div className="panel-body">
            <div className="stablecoin-contract-row">
              <div>
                <div className="stablecoin-label">FEE RATE</div>
                <div className="stablecoin-contract-value">
                  {(contractState.current_fee_bps / 100).toFixed(1)}%
                  <span className="stablecoin-fee-rate"> ({contractState.current_fee_bps} bps)</span>
                </div>
              </div>
              <div>
                <div className="stablecoin-label">STATUS</div>
                <div className="stablecoin-contract-value">
                  {contractState.is_paused ? (
                    <span style={{ color: "var(--red)" }}>Paused</span>
                  ) : (
                    <span style={{ color: "var(--green)" }}>Active</span>
                  )}
                </div>
              </div>
              <div>
                <div className="stablecoin-label">ROUTER</div>
                <a
                  className="stablecoin-row-link stablecoin-extlink"
                  href={basescanAddressUrl(chainId, contractState.settlement_router_address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on BaseScan"
                >
                  <code className="stablecoin-mini-address">
                    {contractState.settlement_router_address.slice(0, 8)}…{contractState.settlement_router_address.slice(-6)}
                  </code>
                  <span className="stablecoin-extlink-icon" aria-hidden>↗</span>
                </a>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
