import { useState, useEffect, useRef } from "react";
import { api, fmtSats } from "../api/client";
import type { SwapRequest, SwapQuoteResponse } from "../api/client";

// ─── State machine ──────────────────────────────────────────────────────────
type Stage = "form" | "quoting" | "quoted" | "initiating" | "tracking";

const AMOUNT_PRESETS = [250_000, 500_000, 1_000_000, 2_000_000];

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "initiated":
      return { label: "Processing", cls: "badge-amber" };
    case "executing":
      return { label: "In Progress", cls: "badge-amber" };
    case "confirming":
      return { label: "Confirming", cls: "badge-blue" };
    case "completed":
      return { label: "Complete", cls: "badge-green" };
    case "failed":
      return { label: "Failed", cls: "badge-red" };
    case "expired":
      return { label: "Expired", cls: "badge-muted" };
    default:
      return { label: status, cls: "badge-muted" };
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "initiated":
      return "Processing withdrawal...";
    case "executing":
      return "Swap in progress...";
    case "confirming":
      return "Confirming on-chain...";
    case "completed":
      return "Withdrawal complete";
    case "failed":
      return `Withdrawal failed${failureReason ? `: ${failureReason}` : ""}`;
    default:
      return status;
  }
}

function formatCountdown(expiresAt: number): string {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "Expired";
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

function formatDate(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function copyToClipboard(text: string) {
  try {
    navigator.clipboard.writeText(text).catch(fallback);
  } catch {
    fallback();
  }
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

export default function WithdrawBitcoin() {
  // ─── Address state (generated on load) ──────────────────────────────────
  const [address, setAddress] = useState<string | null>(null);
  const [addressLoading, setAddressLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // ─── Form state ───────────────────────────────────────────────────────
  const [stage, setStage] = useState<Stage>("form");
  const [amount, setAmount] = useState(250_000);
  const [error, setError] = useState<string | null>(null);

  // ─── Quote state ──────────────────────────────────────────────────────
  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");

  // ─── Tracking state ───────────────────────────────────────────────────
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);

  // ─── History state ────────────────────────────────────────────────────
  const [history, setHistory] = useState<SwapRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // ─── Max withdrawable from treasury channel ─────────────────────────
  const [maxWithdrawable, setMaxWithdrawable] = useState<number | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch max withdrawable from treasury channel ──────────────────────
  useEffect(() => {
    api.getMemberStats()
      .then((s) => {
        if (s.treasury_channel) {
          const buffer = 50_000;
          const feeCushion = 2_000; // conservative estimate for swap + miner fees
          const max = Math.min(s.treasury_channel.local_sats - buffer - feeCushion, 2_000_000);
          setMaxWithdrawable(max >= 250_000 ? max : null);
        }
      })
      .catch(() => {});
  }, []);

  // ─── Generate address on mount ────────────────────────────────────────
  useEffect(() => {
    generateAddress();
    loadHistory();
  }, []);

  async function generateAddress() {
    setAddressLoading(true);
    try {
      const { address: addr } = await api.getNodeAddress();
      setAddress(addr);
    } catch {
      setAddress(null);
    } finally {
      setAddressLoading(false);
    }
  }

  function handleCopy() {
    if (!address) return;
    copyToClipboard(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleNewAddress() {
    setCopied(false);
    generateAddress();
  }

  function loadHistory() {
    setHistoryLoading(true);
    api
      .getSwapHistory(10)
      .then((r) => setHistory(r.swaps))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }

  // ─── Countdown timer for quote expiry ─────────────────────────────────
  useEffect(() => {
    if (stage === "quoted" && quoteResp?.swap_request.quote_expires_at) {
      const expiresMs =
        quoteResp.swap_request.quote_expires_at < 1e12
          ? quoteResp.swap_request.quote_expires_at * 1000
          : quoteResp.swap_request.quote_expires_at;

      const tick = () => {
        const remaining = expiresMs - Date.now();
        if (remaining <= 0) {
          setCountdown("Expired");
          setError("Quote has expired. Please get a new quote.");
          if (countdownRef.current) clearInterval(countdownRef.current);
        } else {
          setCountdown(formatCountdown(expiresMs));
        }
      };
      tick();
      countdownRef.current = setInterval(tick, 1000);
      return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
    }
  }, [stage, quoteResp]);

  // ─── Poll tracking status ─────────────────────────────────────────────
  useEffect(() => {
    if (stage === "tracking" && trackingId) {
      const poll = () => {
        api.getSwap(trackingId)
          .then((detail) => {
            setTrackingSwap(detail.swap_request);
            if (isTerminal(detail.swap_request.status)) {
              if (pollRef.current) clearInterval(pollRef.current);
              loadHistory();
            }
          })
          .catch(() => {});
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
  }, [stage, trackingId]);

  // ─── Get Quote ────────────────────────────────────────────────────────
  async function handleGetQuote() {
    setError(null);
    if (amount < 250_000) { setError("Minimum withdrawal is 250,000 sats"); return; }
    if (!address) { setError("No destination address — try generating a new one"); return; }
    setStage("quoting");
    try {
      const resp = await api.getSwapLoopOutQuote({
        amount_sat: amount,
        destination_address: address,
      });
      setQuoteResp(resp);
      setStage("quoted");
    } catch (e: any) {
      setError(e.message ?? "Failed to get quote");
      setStage("form");
    }
  }

  // ─── Confirm withdrawal ───────────────────────────────────────────────
  async function handleConfirm() {
    if (!quoteResp || !address) return;
    setError(null);
    setStage("initiating");
    try {
      const resp = await api.initiateSwapLoopOut({
        swap_request_id: quoteResp.swap_request.id,
        destination_address: address,
      });
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setStage("tracking");
    } catch (e: any) {
      setError(e.message ?? "Failed to initiate withdrawal");
      setStage("quoted");
    }
  }

  // ─── Reset to form ────────────────────────────────────────────────────
  function handleReset() {
    setStage("form");
    setQuoteResp(null);
    setTrackingId(null);
    setTrackingSwap(null);
    setError(null);
    setCountdown("");
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    generateAddress();
    loadHistory();
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Withdraw Bitcoin</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Send bitcoin from your Lightning balance to a Bitcoin wallet
        </p>
      </div>

      {/* ─── Withdrawal Amount + Destination Address ──────────────────── */}
      {(stage === "form" || stage === "quoting") && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">↗</span>Withdrawal Amount
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Amount */}
            <div>
              <label className="form-label">Amount (sats)</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                {AMOUNT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={`btn ${amount === preset ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}
                    onClick={() => setAmount(preset)}
                  >
                    {preset >= 1_000_000
                      ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
                      : `${(preset / 1_000).toFixed(0)}k`}
                  </button>
                ))}
                {maxWithdrawable && !AMOUNT_PRESETS.includes(maxWithdrawable) && (
                  <button
                    className={`btn ${amount === maxWithdrawable ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto", fontWeight: 600 }}
                    onClick={() => setAmount(maxWithdrawable)}
                  >
                    Max
                  </button>
                )}
              </div>
              <input
                type="number"
                className="form-input"
                min={250000}
                step={10000}
                value={amount}
                onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setAmount(v); }}
                placeholder="250000"
              />
              <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
                Minimum: 250,000 sats. Maximum: 2,000,000 sats.
              </p>
            </div>

            {/* Destination address */}
            <div>
              <label className="form-label">Destination Address</label>
              {addressLoading ? (
                <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
              ) : address ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 14px",
                    background: "var(--bg-3)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      fontFamily: "var(--mono)",
                      fontSize: "0.75rem",
                      color: "var(--text-2)",
                      wordBreak: "break-all",
                      lineHeight: 1.5,
                    }}
                  >
                    {address}
                  </div>
                  <button className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={handleCopy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={handleNewAddress}>
                    New
                  </button>
                </div>
              ) : (
                <div style={{ color: "var(--text-3)", fontSize: "0.8125rem" }}>
                  Failed to generate address —{" "}
                  <button className="btn btn-ghost" style={{ fontSize: "0.8125rem", padding: 0 }} onClick={generateAddress}>
                    retry
                  </button>
                </div>
              )}
              <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
                Your withdrawn bitcoin will be sent to this on-chain address.
              </p>
            </div>

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleGetQuote}
              disabled={stage === "quoting" || addressLoading || !address}
            >
              {stage === "quoting" ? "Getting quote..." : "Get Quote"}
            </button>
          </div>
        </div>
      )}

      {/* ─── Quote Panel ──────────────────────────────────────────────── */}
      {(stage === "quoted" || stage === "initiating") && quoteResp && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">≡</span>Withdrawal Quote
            </span>
            {countdown && (
              <span className={`badge ${countdown === "Expired" ? "badge-red" : "badge-amber"}`}>
                {countdown === "Expired" ? "Expired" : `Expires in ${countdown}`}
              </span>
            )}
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(() => {
              const q = quoteResp.quote;
              const swapFee = q.swap_fee_sat ?? 0;
              const minerFee = q.miner_fee_sat ?? 0;
              const netFee = swapFee + minerFee;
              const prepay = q.prepay_sat ?? 0;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                      <div className="stat-label">Amount</div>
                      <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                        {fmtSats(q.amount_sat)}
                      </div>
                    </div>
                    <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                      <div className="stat-label">Estimated Fee</div>
                      <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                        ~{fmtSats(netFee)}
                      </div>
                      {(swapFee > 0 || minerFee > 0) && (
                        <div style={{ fontSize: "0.6875rem", color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 4 }}>
                          {swapFee > 0 && <span>Swap: {fmtSats(swapFee)}</span>}
                          {swapFee > 0 && minerFee > 0 && <span> + </span>}
                          {minerFee > 0 && <span>Miner: {fmtSats(minerFee)}</span>}
                        </div>
                      )}
                    </div>
                    <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                      <div className="stat-label">You Will Receive</div>
                      <div className="stat-value" style={{ fontSize: "1.125rem", color: "var(--green)" }}>
                        ~{fmtSats(q.amount_sat - netFee)}
                      </div>
                    </div>
                  </div>
                  {prepay > 0 && (
                    <div style={{ fontSize: "0.75rem", color: "var(--text-3)", padding: "8px 12px", background: "var(--bg-3)", borderRadius: 6 }}>
                      A temporary prepay hold of <strong style={{ color: "var(--text-2)" }}>{fmtSats(prepay)}</strong> is
                      sent during the swap and returned as part of your on-chain payment. It is not an additional fee.
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
              To: {address}
            </div>

            {!quoteResp.policy_check.ok && (
              <div className="alert warning" style={{ marginBottom: 0 }}>
                <span className="alert-icon">⚠</span>
                <div className="alert-body">
                  <div className="alert-msg">{(quoteResp.policy_check as { reason: string }).reason}</div>
                </div>
              </div>
            )}

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleConfirm}
                disabled={stage === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}
              >
                {stage === "initiating" ? "Processing..." : "Confirm Withdrawal"}
              </button>
              <button className="btn btn-outline" onClick={handleReset} disabled={stage === "initiating"}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Status Tracking Panel ────────────────────────────────────── */}
      {stage === "tracking" && trackingSwap && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">◎</span>Withdrawal Status
            </span>
            <span className={`badge ${statusBadge(trackingSwap.status).cls}`}>
              {statusBadge(trackingSwap.status).label}
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Amount</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(trackingSwap.amount_sat)}</div>
              </div>
              {trackingSwap.actual_fee_sat != null && (
                <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                  <div className="stat-label">Actual Fee</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(trackingSwap.actual_fee_sat)}</div>
                </div>
              )}
            </div>

            {trackingSwap.destination_address && (
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
                To: {trackingSwap.destination_address}
              </div>
            )}

            <div
              style={{
                padding: "10px 14px",
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: "0.875rem",
                color: trackingSwap.status === "failed" ? "var(--red)" : "var(--text-2)",
              }}
            >
              {statusText(trackingSwap.status, trackingSwap.failure_reason)}
              {!isTerminal(trackingSwap.status) && (
                <span
                  className="loading-shimmer"
                  style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", marginLeft: 8, verticalAlign: "middle" }}
                />
              )}
            </div>

            {isTerminal(trackingSwap.status) && (
              <button className="btn btn-outline" onClick={handleReset} style={{ alignSelf: "flex-start" }}>
                New Withdrawal
              </button>
            )}
          </div>
        </div>
      )}

      {/* ─── Recent Withdrawals ───────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↗</span>Recent Withdrawals
          </span>
          {!historyLoading && history.length > 0 && (
            <span className="badge badge-muted">{history.length}</span>
          )}
        </div>
        <div className="panel-body">
          {historyLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="empty-state">No withdrawals yet</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((s) => {
                    const badge = statusBadge(s.status);
                    return (
                      <tr key={s.id}>
                        <td>{formatDate(s.created_at)}</td>
                        <td className="td-num td-mono">{s.amount_sat.toLocaleString()}</td>
                        <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                        <td className="td-num td-mono">
                          {s.actual_fee_sat != null
                            ? s.actual_fee_sat.toLocaleString()
                            : s.quoted_fee_sat != null
                              ? `~${s.quoted_fee_sat.toLocaleString()}`
                              : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
