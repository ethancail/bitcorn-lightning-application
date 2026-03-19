import { useState, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { api, fmtSats } from "../api/client";
import type { OnChainStatus, OnChainDeposit } from "../api/client";

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function depositStatus(d: OnChainDeposit): { label: string; badge: string } {
  if (!d.is_confirmed) return { label: "Pending", badge: "badge-amber" };
  if (d.confirmations < 3) return { label: `${d.confirmations} confirmation${d.confirmations === 1 ? "" : "s"}`, badge: "badge-amber" };
  if (d.confirmations < 6) return { label: `${d.confirmations} confirmations`, badge: "badge-blue" };
  return { label: "Confirmed", badge: "badge-green" };
}

export default function DepositBitcoin() {
  const [address, setAddress] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedTx, setCopiedTx] = useState<string | null>(null);

  // On-chain status
  const [status, setStatus] = useState<OnChainStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    api
      .getNodeAddress()
      .then(async (data) => {
        setAddress(data.address);
        const url = await QRCode.toDataURL(`bitcoin:${data.address}`, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setQrDataUrl(url);
      })
      .catch(() => setError("Failed to generate deposit address"))
      .finally(() => setLoading(false));
  }, []);

  const fetchStatus = useCallback(() => {
    api.getOnChainStatus()
      .then(setStatus)
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, []);

  // Poll on-chain status every 15s
  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 15_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  function handleCopy() {
    if (!address) return;
    try {
      navigator.clipboard.writeText(address).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(fallbackCopy);
    } catch {
      fallbackCopy();
    }
  }

  function fallbackCopy() {
    if (!address) return;
    copyToClipboard(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function copyToClipboard(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function handleCopyTx(txHash: string) {
    try {
      navigator.clipboard.writeText(txHash).then(() => {
        setCopiedTx(txHash);
        setTimeout(() => setCopiedTx(null), 2000);
      }).catch(() => {
        copyToClipboard(txHash);
        setCopiedTx(txHash);
        setTimeout(() => setCopiedTx(null), 2000);
      });
    } catch {
      copyToClipboard(txHash);
      setCopiedTx(txHash);
      setTimeout(() => setCopiedTx(null), 2000);
    }
  }

  function handleNewAddress() {
    setLoading(true);
    setError(null);
    setQrDataUrl(null);
    api
      .getNodeAddress()
      .then(async (data) => {
        setAddress(data.address);
        const url = await QRCode.toDataURL(`bitcoin:${data.address}`, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setQrDataUrl(url);
      })
      .catch(() => setError("Failed to generate deposit address"))
      .finally(() => setLoading(false));
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Deposit Bitcoin</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Send bitcoin to your node's on-chain wallet
        </p>
      </div>

      {/* ─── Address + QR ─────────────────────────────────────────── */}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↙</span>On-Chain Address
          </span>
          <span className="badge badge-muted">not a Lightning invoice</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "32px 24px" }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <div className="loading-shimmer" style={{ width: 280, height: 280, borderRadius: 8 }} />
              <div className="loading-shimmer" style={{ width: 320, height: 20, borderRadius: 4 }} />
            </div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : (
            <>
              {qrDataUrl && (
                <div style={{ background: "#ffffff", padding: 16, borderRadius: 12 }}>
                  <img src={qrDataUrl} alt="Bitcoin deposit address QR code" style={{ display: "block", width: 280, height: 280 }} />
                </div>
              )}

              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "0.8125rem",
                  color: "var(--text-2)",
                  wordBreak: "break-all",
                  textAlign: "center",
                  maxWidth: 400,
                  lineHeight: 1.6,
                }}
              >
                {address}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={handleCopy}>
                  {copied ? "Copied" : "Copy Address"}
                </button>
                <button className="btn btn-outline" onClick={handleNewAddress}>
                  New Address
                </button>
              </div>

              <p
                className="text-dim"
                style={{
                  fontSize: "0.75rem",
                  textAlign: "center",
                  maxWidth: 360,
                  lineHeight: 1.5,
                  marginTop: 4,
                }}
              >
                Send bitcoin on the Bitcoin mainnet to this address. This is an on-chain transaction — not Lightning. Funds will appear in your on-chain balance after confirmation.
              </p>
            </>
          )}
        </div>
      </div>

      {/* ─── On-Chain Status ──────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◎</span>On-Chain Balance
          </span>
          <button
            className="btn btn-ghost"
            style={{ fontSize: "0.75rem", padding: "2px 8px" }}
            onClick={() => { setStatusLoading(true); fetchStatus(); }}
          >
            Refresh
          </button>
        </div>
        <div className="panel-body">
          {statusLoading && !status ? (
            <div style={{ display: "flex", gap: 16 }}>
              <div className="loading-shimmer" style={{ flex: 1, height: 60, borderRadius: 6 }} />
              <div className="loading-shimmer" style={{ flex: 1, height: 60, borderRadius: 6 }} />
            </div>
          ) : status ? (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Confirmed</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                  {fmtSats(status.confirmed_balance_sat)}
                </div>
              </div>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Pending</div>
                <div className="stat-value" style={{ fontSize: "1.125rem", color: status.pending_balance_sat > 0 ? "var(--amber)" : undefined }}>
                  {fmtSats(status.pending_balance_sat)}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-dim" style={{ fontSize: "0.8125rem" }}>Unable to load on-chain status</div>
          )}
          <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 12, lineHeight: 1.5 }}>
            Incoming deposits may appear as pending before they are confirmed on-chain. Confirmed funds are available in your on-chain balance after network confirmation.
          </p>
        </div>
      </div>

      {/* ─── Recent Deposits ──────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↓</span>Recent Deposits
          </span>
          <span className="badge badge-muted">on-chain only</span>
        </div>
        <div className="panel-body">
          {statusLoading && !status ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />
              ))}
            </div>
          ) : !status || status.recent_deposits.length === 0 ? (
            <div className="empty-state">No incoming on-chain transactions yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {status.recent_deposits.map((d) => {
                const { label, badge } = depositStatus(d);
                return (
                  <div
                    key={d.tx_hash}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      background: "var(--bg-3)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>
                        +{d.amount_sat.toLocaleString()} sats
                      </div>
                      <button
                        onClick={() => handleCopyTx(d.tx_hash)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          fontFamily: "var(--mono)",
                          fontSize: "0.6875rem",
                          color: "var(--text-3)",
                        }}
                        title="Copy transaction hash"
                      >
                        {copiedTx === d.tx_hash ? "copied!" : `${d.tx_hash.slice(0, 12)}…${d.tx_hash.slice(-8)}`}
                      </button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <span className={`badge ${badge}`} style={{ fontSize: "0.6875rem" }}>
                        {label}
                      </span>
                      <span className="text-dim" style={{ fontSize: "0.6875rem", whiteSpace: "nowrap" }}>
                        {timeAgo(d.time_stamp)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
