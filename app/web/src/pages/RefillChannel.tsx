import React, { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, fmtSats } from "../api/client";
import type { SwapRequest, SwapQuoteResponse } from "../api/client";
import ErrorState from "../components/ErrorState";
import TechnicalDetails, { TechRow } from "../components/TechnicalDetails";
import ActionConfirmModal, {
  useActionConfirm,
} from "../components/actionConfirm/ActionConfirmModal";
import { summarizeLoopIn } from "../components/actionConfirm/confirmAction";
import { classifyConfirmError } from "../components/actionConfirm/confirmErrors";
import {
  INITIAL_FRESHNESS,
  ageLabel,
  freshnessStatus,
  recordFailure,
  recordSuccess,
  type FreshnessState,
} from "../components/freshness";

// ─── State machine ──────────────────────────────────────────────────────────
type Stage = "loading" | "form" | "quoting" | "quoted" | "initiating" | "tracking";

const AMOUNT_PRESETS = [250_000, 500_000, 1_000_000, 2_000_000];

// ─── Helpers (mirrored from WithdrawBitcoin — acceptable duplication) ───────

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

// Plain-language status per the 2026-07-09 vocabulary record (U1/U2; Knot 2
// updated: this operation is "Top Up"). Protocol-register originals live in
// statusTechnical — demoted into the Technical details expander, not deleted.
function statusText(status: string, amount: number, failureReason: string | null): string {
  switch (status) {
    case "initiated":
      return "Starting your top up...";
    case "executing":
      return "Moving funds into your channel...";
    case "confirming":
      return "Almost there — settling...";
    case "completed":
      return `Top up complete. ${amount.toLocaleString()} sats added to your channel.`;
    case "failed":
      return `Top up failed${failureReason ? `: ${failureReason}` : ""}`;
    default:
      return status;
  }
}

function statusTechnical(status: string): string {
  switch (status) {
    case "initiated": return "Publishing on-chain HTLC";
    case "executing": return "Waiting for Lightning payment from Loop server";
    case "confirming": return "Settling swap";
    default: return status;
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

// ─── Channel state bar color ────────────────────────────────────────────────

function pctColor(pct: number): string {
  if (pct < 30) return "var(--red)";
  if (pct < 60) return "var(--amber)";
  return "var(--green)";
}

export default function RefillChannel() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // ─── Stage state ──────────────────────────────────────────────────────
  const [stage, setStage] = useState<Stage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // ─── Channel state ────────────────────────────────────────────────────
  const [channelLocal, setChannelLocal] = useState<number | null>(null);
  const [channelCapacity, setChannelCapacity] = useState<number | null>(null);

  // ─── On-chain balance ─────────────────────────────────────────────────
  const [onchainBalance, setOnchainBalance] = useState<number | null>(null);

  // ─── Form state ───────────────────────────────────────────────────────
  const advisorAmount = searchParams.get("amount");
  const [amount, setAmount] = useState(() => {
    const fromUrl = advisorAmount ? Number(advisorAmount) : 0;
    return fromUrl > 0 ? fromUrl : 250_000;
  });

  // ─── Quote state ──────────────────────────────────────────────────────
  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");

  // ─── Tracking state ───────────────────────────────────────────────────
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);

  // ─── History state ────────────────────────────────────────────────────
  const [history, setHistory] = useState<SwapRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // BTC/USD for the fee $ estimate — same source + null→sats-only degrade as
  // the dashboard (Knot 3, vocabulary record 2026-07-09).
  const [usdRate, setUsdRate] = useState<number | null>(null);
  // U24 H5: tracking-poll freshness — after 3 consecutive failed polls the
  // tracking panel says it can't confirm status instead of spinning silently.
  const [pollFresh, setPollFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [expandedSwapId, setExpandedSwapId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<{ swap_request: SwapRequest; execution: any; events: any[] } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Derived values ───────────────────────────────────────────────────
  const channelPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0
      ? Math.round((channelLocal / channelCapacity) * 100)
      : null;

  const channelRemote = channelCapacity != null && channelLocal != null
    ? channelCapacity - channelLocal : null;
  const maxRefill =
    onchainBalance != null
      ? Math.max(Math.min(
          onchainBalance - 50_000 - 10_000,
          channelRemote ?? 3_000_000,
          3_000_000
        ), 0)
      : null;

  const projectedPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0 && amount > 0
      ? Math.round(((channelLocal + amount) / channelCapacity) * 100)
      : null;

  // ─── Mount: fetch channel + balance + check in-flight swaps ───────────
  useEffect(() => {
    async function init() {
      try {
        // Fetch channel info + on-chain balance in parallel
        const [stats, balances, histResp] = await Promise.all([
          api.getMemberStats().catch(() => null),
          api.getNodeBalances().catch(() => null),
          api.getSwapHistory(5).catch(() => ({ swaps: [] as SwapRequest[] })),
        ]);

        if (stats?.treasury_channel) {
          setChannelLocal(stats.treasury_channel.local_sats);
          setChannelCapacity(stats.treasury_channel.capacity_sats);
        }
        if (balances) {
          setOnchainBalance(balances.onchain_sats);
        }

        // Check for in-flight loop_in swap
        const inflight = histResp.swaps.find(
          (s) => s.swap_type === "loop_in" && !isTerminal(s.status)
        );
        if (inflight) {
          setTrackingId(inflight.id);
          setTrackingSwap(inflight);
          setStage("tracking");
        } else {
          setStage("form");
        }
      } catch {
        setStage("form");
      }
    }
    init();
    loadHistory();
    api.getExchangeRate().then((r) => setUsdRate(r.usd)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toUsd = (sats: number) =>
    usdRate ? `$${((sats / 100_000_000) * usdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

  function loadHistory() {
    setHistoryLoading(true);
    api
      .getSwapHistory(10)
      .then((r) => { setHistory(r.swaps.filter((s) => s.swap_type === "loop_in")); setHistoryError(null); })
      // U24 H4: keep last-good rows on failure — never clear to [] (which
      // rendered as "No top ups yet" while a swap could be in flight).
      .catch((e: any) => setHistoryError(e?.detail ?? e?.message ?? "fetch failed"))
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
      return () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
      };
    }
  }, [stage, quoteResp]);

  // ─── Poll tracking status ─────────────────────────────────────────────
  useEffect(() => {
    if (stage === "tracking" && trackingId) {
      setPollFresh(INITIAL_FRESHNESS);
      const poll = () => {
        api
          .getSwap(trackingId)
          .then((detail) => {
            setPollFresh((s) => recordSuccess(s, Date.now()));
            setTrackingSwap(detail.swap_request);
            if (isTerminal(detail.swap_request.status)) {
              if (pollRef.current) clearInterval(pollRef.current);
              loadHistory();
            }
          })
          .catch(() => setPollFresh(recordFailure));
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [stage, trackingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Stuck swap detection (> 30 min) ──────────────────────────────────
  const isStuck =
    trackingSwap &&
    !isTerminal(trackingSwap.status) &&
    trackingSwap.updated_at &&
    Date.now() - (trackingSwap.updated_at < 1e12 ? trackingSwap.updated_at * 1000 : trackingSwap.updated_at) > 30 * 60_000;

  // ─── Expand history row ───────────────────────────────────────────────
  async function handleExpandSwap(swapId: string) {
    if (expandedSwapId === swapId) {
      setExpandedSwapId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedSwapId(swapId);
    setExpandedDetail(null);
    try {
      const detail = await api.getSwap(swapId);
      setExpandedDetail(detail);
    } catch {
      setExpandedDetail(null);
    }
  }

  // ─── Get Quote ────────────────────────────────────────────────────────
  async function handleGetQuote() {
    setError(null);
    setWarning(null);
    if (amount < 100_000) {
      setError("Minimum top up is 100,000 sats");
      return;
    }
    if (maxRefill != null && amount > maxRefill) {
      setError("Amount exceeds available on-chain balance");
      return;
    }
    setStage("quoting");
    try {
      const resp = await api.getSwapLoopInQuote({ amount_sat: amount });
      setQuoteResp(resp);
      setStage("quoted");
    } catch (e: any) {
      const msg = e.message ?? "";
      if (msg.includes("loop_unavailable")) {
        setWarning("Loop service is temporarily unavailable. Try again in a few minutes.");
      } else if (msg.includes("route_unavailable") || e.status === 503) {
        setWarning(`Treasury has no inbound capacity for ${amount.toLocaleString()} sats right now. Try a smaller amount or check back shortly.`);
      } else {
        setError(msg || "Failed to get quote");
      }
      setStage("form");
    }
  }

  // ─── Confirm refill ───────────────────────────────────────────────────
  const confirm = useActionConfirm();

  function openRefillConfirm() {
    if (!quoteResp) return;
    confirm.open(
      summarizeLoopIn({
        amountSats: quoteResp.quote.amount_sat,
        feeSats: quoteResp.quote.total_fee_sat,
      }),
    );
  }

  async function handleConfirm() {
    if (!quoteResp) return;
    setError(null);
    setStage("initiating");
    try {
      const resp = await api.initiateSwapLoopIn({
        swap_request_id: quoteResp.swap_request.id,
      });
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setStage("tracking");
    } catch (e: any) {
      setStage("quoted");
      if (classifyConfirmError(e)) throw e;
      setError(e.message ?? "Failed to start the top up");
    }
  }

  // ─── Reset to form ────────────────────────────────────────────────────
  function handleReset() {
    setStage("form");
    setQuoteResp(null);
    setTrackingId(null);
    setTrackingSwap(null);
    setError(null);
    setWarning(null);
    setCountdown("");
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    loadHistory();
    // Refresh channel + balance
    api.getMemberStats().then((s) => {
      if (s.treasury_channel) {
        setChannelLocal(s.treasury_channel.local_sats);
        setChannelCapacity(s.treasury_channel.capacity_sats);
      }
    }).catch(() => {});
    api.getNodeBalances().then((b) => setOnchainBalance(b.onchain_sats)).catch(() => {});
  }

  // ─── Insufficient on-chain helper ─────────────────────────────────────
  const insufficientOnchain = onchainBalance != null && onchainBalance < 60_000;

  // ─── Loading stage ────────────────────────────────────────────────────
  if (stage === "loading") {
    return (
      <div>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ marginBottom: 4 }}>Top Up</h1>
          <p className="text-dim" style={{ fontSize: "0.875rem" }}>
            Move funds from your Bitcoin balance into your channel so you can send
          </p>
        </div>
        <div className="panel">
          <div className="panel-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Top Up</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Move funds from your Bitcoin balance into your channel so you can send
        </p>
      </div>

      {/* ─── Form + Quoting stage ─────────────────────────────────────── */}
      {(stage === "form" || stage === "quoting") && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">↙</span>Top Up Amount
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Channel state bar */}
            {channelPct != null && (
              <div>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  marginBottom: 6, fontSize: "0.75rem", fontFamily: "var(--mono)",
                }}>
                  <span style={{ color: "var(--text-3)" }}>Channel Balance</span>
                  <span style={{ color: pctColor(channelPct), fontWeight: 600 }}>{channelPct}% local</span>
                </div>
                <div style={{
                  height: 8, borderRadius: 4,
                  background: "var(--bg-3)",
                  overflow: "hidden",
                }}>
                  <div style={{
                    width: `${Math.min(channelPct, 100)}%`,
                    height: "100%",
                    borderRadius: 4,
                    background: pctColor(channelPct),
                    transition: "width 0.3s ease",
                  }} />
                </div>
                {advisorAmount && Number(advisorAmount) > 0 && (
                  <p style={{
                    fontSize: "0.75rem", color: "var(--text-3)", marginTop: 6,
                    fontStyle: "italic",
                  }}>
                    Bitcorn recommends {Number(advisorAmount).toLocaleString()} sats — tap Max or adjust.
                  </p>
                )}
              </div>
            )}

            {/* On-chain balance card (amber-tinted) */}
            {onchainBalance != null && (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                padding: "10px 14px", borderRadius: 8,
                background: "color-mix(in srgb, var(--amber) 8%, var(--bg-2))",
                border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
              }}>
                <div>
                  <div style={{
                    fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase",
                    letterSpacing: "0.06em", color: "var(--text-3)",
                  }}>
                    Bitcoin Balance
                  </div>
                  <div style={{
                    fontFamily: "var(--mono)", fontSize: "1.125rem", fontWeight: 600,
                    color: "var(--amber)", lineHeight: 1.2,
                  }}>
                    {onchainBalance.toLocaleString()}
                    <span style={{ fontSize: "0.75rem", color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>
                      sats
                    </span>
                  </div>
                </div>
                {maxRefill != null && maxRefill >= 100_000 && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{
                      fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase",
                      letterSpacing: "0.06em", color: "var(--text-3)",
                    }}>
                      Most you can add
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", color: "var(--text-2)" }}>
                      {maxRefill.toLocaleString()} sats
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Insufficient on-chain warning */}
            {insufficientOnchain && (
              <div className="alert critical" style={{ marginBottom: 0 }}>
                <span className="alert-icon">!</span>
                <div className="alert-body">
                  <div className="alert-msg">
                    Not enough in your Bitcoin balance — you need at least 60,000 sats to cover this plus fees.
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      className="btn btn-outline"
                      style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                      onClick={() => navigate("/deposit")}
                    >
                      Deposit Bitcoin
                    </button>
                    <button
                      className="btn btn-outline"
                      style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                      onClick={() => {
                        api.getCoinbaseOnrampUrl()
                          .then((r) => window.open(r.url, "_blank", "noopener,noreferrer"))
                          .catch(() => {});
                      }}
                    >
                      Fund Node via Coinbase
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Amount presets */}
            <div>
              <label className="form-label">Amount</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                {AMOUNT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={`btn ${amount === preset ? "btn-primary" : "btn-outline"}`}
                    style={{
                      fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto",
                      opacity: maxRefill != null && preset > maxRefill ? 0.4 : 1,
                    }}
                    onClick={() => setAmount(preset)}
                    disabled={maxRefill != null && preset > maxRefill}
                  >
                    {preset >= 1_000_000
                      ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
                      : `${(preset / 1_000).toFixed(0)}k`}
                  </button>
                ))}
                {maxRefill != null && maxRefill > 0 && (
                  <button
                    className={`btn ${amount === maxRefill ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto", fontWeight: 600 }}
                    onClick={() => setAmount(maxRefill)}
                    title={`${maxRefill.toLocaleString()} sats`}
                  >
                    Max
                  </button>
                )}
              </div>
              <div style={{ position: "relative" }}>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  value={amount > 0 ? amount.toLocaleString() : ""}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, "");
                    if (raw === "") { setAmount(0); return; }
                    setAmount(Number(raw));
                  }}
                  placeholder="250,000"
                  style={{ paddingRight: 42 }}
                />
                <span style={{
                  position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
                }}>
                  sats
                </span>
              </div>
              <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
                Minimum: 100,000 sats
              </p>
              {amount > 0 && amount < 100_000 && (
                <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
                  Minimum top up is 100,000 sats
                </div>
              )}
            </div>

            {/* Projected state strip */}
            {projectedPct != null && channelPct != null && amount >= 100_000 && (
              <div style={{
                padding: "10px 14px",
                borderLeft: "3px solid var(--amber)",
                background: "var(--bg-3)",
                borderRadius: "0 6px 6px 0",
                fontSize: "0.8125rem",
                fontFamily: "var(--mono)",
                color: "var(--text-2)",
              }}>
                After top up: <span style={{ color: pctColor(channelPct) }}>{channelPct}%</span>
                {" → "}
                <span style={{ color: pctColor(Math.min(projectedPct, 100)), fontWeight: 600 }}>
                  {Math.min(projectedPct, 100)}%
                </span> local
              </div>
            )}

            {projectedPct != null && projectedPct > 100 && (
              <div className="alert warning" style={{ marginBottom: 10, fontSize: "0.75rem" }}>
                That's more than your channel can hold right now. Try a smaller amount.
              </div>
            )}

            {/* Route unavailable warning */}
            {warning && (
              <div className="alert warning" style={{ marginBottom: 0 }}>
                <span className="alert-icon">!</span>
                <div className="alert-body">
                  <div className="alert-msg">{warning}</div>
                </div>
              </div>
            )}

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleGetQuote}
              disabled={stage === "quoting" || insufficientOnchain || amount < 100_000}
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
              <span className="icon">≡</span>Top Up Quote
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
              const htlcFee = q.htlc_publish_fee_sat ?? 0;
              const totalFee = swapFee + minerFee + htlcFee;
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
                        ~{fmtSats(totalFee)}
                      </div>
                      {toUsd(totalFee) && (
                        <div style={{ fontSize: "0.6875rem", color: "var(--text-3)", marginTop: 4 }}>
                          (~{toUsd(totalFee)})
                        </div>
                      )}
                    </div>
                    <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                      <div className="stat-label">Added to Channel</div>
                      <div className="stat-value" style={{ fontSize: "1.125rem", color: "var(--green)" }}>
                        ~{fmtSats(q.amount_sat - totalFee)}
                      </div>
                    </div>
                  </div>
                  {/* Protocol fee breakdown — demoted per U2/Knot 3 */}
                  <TechnicalDetails>
                    {swapFee > 0 && <TechRow label="Swap service fee">{fmtSats(swapFee)}</TechRow>}
                    {minerFee > 0 && <TechRow label="Bitcoin network (miner) fee">{fmtSats(minerFee)}</TechRow>}
                    {htlcFee > 0 && <TechRow label="HTLC publish fee">{fmtSats(htlcFee)}</TechRow>}
                  </TechnicalDetails>
                </div>
              );
            })()}

            {/* Projected state */}
            {projectedPct != null && channelPct != null && (
              <div style={{
                padding: "10px 14px",
                borderLeft: "3px solid var(--amber)",
                background: "var(--bg-3)",
                borderRadius: "0 6px 6px 0",
                fontSize: "0.8125rem",
                fontFamily: "var(--mono)",
                color: "var(--text-2)",
              }}>
                After top up: <span style={{ color: pctColor(channelPct) }}>{channelPct}%</span>
                {" → "}
                <span style={{ color: pctColor(Math.min(projectedPct, 100)), fontWeight: 600 }}>
                  {Math.min(projectedPct, 100)}%
                </span> local
              </div>
            )}

            {!quoteResp.policy_check.ok && (
              <div className="alert warning" style={{ marginBottom: 0 }}>
                <span className="alert-icon">!</span>
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
                onClick={openRefillConfirm}
                disabled={stage === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}
              >
                {stage === "initiating" ? "Processing..." : "Confirm Top Up"}
              </button>
              <button className="btn btn-outline" onClick={handleReset} disabled={stage === "initiating"}>
                Cancel
              </button>
            </div>

            <ActionConfirmModal controller={confirm} onConfirm={handleConfirm} />
          </div>
        </div>
      )}

      {/* ─── Status Tracking Panel ────────────────────────────────────── */}
      {stage === "tracking" && trackingSwap && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">◎</span>Top Up Status
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
              {statusText(trackingSwap.status, trackingSwap.amount_sat, trackingSwap.failure_reason)}
              {!isTerminal(trackingSwap.status) && (
                <span
                  className="loading-shimmer"
                  style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", marginLeft: 8, verticalAlign: "middle" }}
                />
              )}
            </div>

            {!isTerminal(trackingSwap.status) && (
              <TechnicalDetails>
                <TechRow label="Protocol status">
                  {trackingSwap.status} — {statusTechnical(trackingSwap.status)}
                </TechRow>
              </TechnicalDetails>
            )}

            {/* U24 H5: status polls failing — say so instead of spinning silently. */}
            {!isTerminal(trackingSwap.status) && freshnessStatus(pollFresh, true) === "stale" && (
              <div className="alert warning" style={{ marginBottom: 0 }}>
                <span className="alert-icon">⚠</span>
                <div className="alert-body">
                  <div className="alert-msg">
                    Can't confirm the status right now — last update{" "}
                    {pollFresh.lastSuccessAt != null ? ageLabel(pollFresh.lastSuccessAt, Date.now()) : "unavailable since this page loaded"}.
                    Retrying automatically; your funds are safe either way.
                  </div>
                </div>
              </div>
            )}

            {/* Stuck swap warning */}
            {isStuck && (
              <div className="alert warning" style={{ marginBottom: 0 }}>
                <span className="alert-icon">!</span>
                <div className="alert-body">
                  <div className="alert-msg">
                    Taking longer than expected. Your funds are safe — automatic refund if swap doesn't complete.
                  </div>
                </div>
              </div>
            )}

            {isTerminal(trackingSwap.status) && (
              <button className="btn btn-outline" onClick={handleReset} style={{ alignSelf: "flex-start" }}>
                {trackingSwap.status === "failed" ? "Start New Top Up" : "New Top Up"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ─── Recent Top Ups ───────────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↙</span>Recent Top Ups
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
          ) : historyError !== null && history.length === 0 ? (
            <ErrorState
              bare
              message="Couldn't load your top up history."
              detail={historyError}
              onRetry={loadHistory}
            />
          ) : history.length === 0 ? (
            <div className="empty-state">No top ups yet</div>
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
                    const isExpanded = expandedSwapId === s.id;
                    return (
                      <React.Fragment key={s.id}>
                        <tr
                          onClick={() => handleExpandSwap(s.id)}
                          style={{ cursor: "pointer", background: isExpanded ? "color-mix(in srgb, var(--amber) 6%, transparent)" : undefined }}
                        >
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
                        {isExpanded && (
                          <tr>
                            <td colSpan={4} style={{ padding: 0, border: "none" }}>
                              <div style={{
                                padding: "12px 16px", background: "var(--bg-2)",
                                borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
                                fontSize: "0.75rem", display: "flex", flexDirection: "column", gap: 8,
                              }}>
                                {!expandedDetail ? (
                                  <div className="loading-shimmer" style={{ height: 60, borderRadius: 6 }} />
                                ) : (
                                  <>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Amount:</span>{" "}
                                        <strong>{expandedDetail.swap_request.amount_sat.toLocaleString()} sats</strong>
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Status:</span>{" "}
                                        <span className={`badge ${statusBadge(expandedDetail.swap_request.status).cls}`}>
                                          {statusBadge(expandedDetail.swap_request.status).label}
                                        </span>
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Quoted Fee:</span>{" "}
                                        {expandedDetail.swap_request.quoted_fee_sat != null
                                          ? `${expandedDetail.swap_request.quoted_fee_sat.toLocaleString()} sats`
                                          : "—"}
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Actual Fee:</span>{" "}
                                        {expandedDetail.swap_request.actual_fee_sat != null
                                          ? `${expandedDetail.swap_request.actual_fee_sat.toLocaleString()} sats`
                                          : "—"}
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Created:</span>{" "}
                                        {formatDate(expandedDetail.swap_request.created_at)}
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Updated:</span>{" "}
                                        {formatDate(expandedDetail.swap_request.updated_at)}
                                      </div>
                                    </div>
                                    {expandedDetail.swap_request.failure_reason && (
                                      <div style={{ color: "var(--red)", fontFamily: "var(--mono)", fontSize: "0.7rem" }}>
                                        Failure: {expandedDetail.swap_request.failure_reason}
                                      </div>
                                    )}
                                    {expandedDetail.execution?.provider_swap_id && (
                                      <div style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--text-3)", wordBreak: "break-all" }}>
                                        Swap hash: {expandedDetail.execution.provider_swap_id}
                                      </div>
                                    )}
                                    {expandedDetail.execution?.onchain_txid && (
                                      <div style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--text-3)", wordBreak: "break-all" }}>
                                        On-chain TX: {expandedDetail.execution.onchain_txid}
                                      </div>
                                    )}
                                    {!isTerminal(expandedDetail.swap_request.status) && (
                                      <button
                                        className="btn btn-outline"
                                        style={{ alignSelf: "flex-start", fontSize: "0.7rem", padding: "4px 12px" }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setTrackingId(expandedDetail.swap_request.id);
                                          setTrackingSwap(expandedDetail.swap_request);
                                          setStage("tracking");
                                          setExpandedSwapId(null);
                                        }}
                                      >
                                        View Live Status →
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
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
