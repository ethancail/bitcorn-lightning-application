import { useState, useEffect, useRef, useCallback } from "react";
import { api, fmtSats } from "../api/client";
import type { SwapRequest, SwapQuoteResponse } from "../api/client";

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Phase = "form" | "quoting" | "quoted" | "initiating" | "tracking";
type Tab = "loop_out" | "loop_in";

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
    case "quoted":
      return { label: "Quoted", cls: "badge-muted" };
    case "expired":
      return { label: "Expired", cls: "badge-muted" };
    default:
      return { label: status, cls: "badge-muted" };
  }
}

function typeBadge(swapType: string): { label: string; cls: string } {
  if (swapType === "loop_out" || swapType === "loopout")
    return { label: "Loop Out", cls: "badge-amber" };
  if (swapType === "loop_in" || swapType === "loopin")
    return { label: "Loop In", cls: "badge-blue" };
  return { label: swapType, cls: "badge-muted" };
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "initiated":
      return "Swap initiated, processing...";
    case "executing":
      return "Swap in progress...";
    case "confirming":
      return "Confirming on-chain...";
    case "completed":
      return "Swap complete";
    case "failed":
      return `Swap failed${failureReason ? `: ${failureReason}` : ""}`;
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
  if (!epoch) return "\u2014";
  const d = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ─── Loop Out Tab ────────────────────────────────────────────────────────────

function LoopOutTab() {
  const [phase, setPhase] = useState<Phase>("form");
  const [amount, setAmount] = useState(250_000);
  const [channelId, setChannelId] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");

  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer
  useEffect(() => {
    if (phase === "quoted" && quoteResp?.swap_request.quote_expires_at) {
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
  }, [phase, quoteResp]);

  // Poll tracking
  useEffect(() => {
    if (phase === "tracking" && trackingId) {
      const poll = () => {
        api
          .adminGetSwap(trackingId)
          .then((detail) => {
            setTrackingSwap(detail.swap_request);
            if (isTerminal(detail.swap_request.status)) {
              if (pollRef.current) clearInterval(pollRef.current);
            }
          })
          .catch(() => {});
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [phase, trackingId]);

  async function handleGetQuote() {
    setError(null);
    if (amount < 250_000) {
      setError("Minimum swap is 250,000 sats");
      return;
    }
    setPhase("quoting");
    try {
      const body: { amount_sat: number; channel_id?: string } = { amount_sat: amount };
      if (channelId.trim()) body.channel_id = channelId.trim();
      const resp = await api.adminLoopOutQuote(body);
      setQuoteResp(resp);
      setPhase("quoted");
    } catch (e: any) {
      setError(e.message ?? "Failed to get quote");
      setPhase("form");
    }
  }

  async function handleExecute() {
    if (!quoteResp) return;
    setError(null);
    setPhase("initiating");
    try {
      const body: { swap_request_id: string; destination_address?: string } = {
        swap_request_id: quoteResp.swap_request.id,
      };
      if (destinationAddress.trim()) body.destination_address = destinationAddress.trim();
      const resp = await api.adminLoopOut(body);
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setPhase("tracking");
    } catch (e: any) {
      setError(e.message ?? "Failed to execute Loop Out");
      setPhase("quoted");
    }
  }

  function handleReset() {
    setPhase("form");
    setQuoteResp(null);
    setTrackingId(null);
    setTrackingSwap(null);
    setError(null);
    setCountdown("");
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // ─── Form ─────────────────────────────────────────────────────────────────
  if (phase === "form" || phase === "quoting") {
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↗</span>Loop Out
          </span>
          <span className="badge badge-muted">restore inbound capacity</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p className="text-dim" style={{ fontSize: "0.8125rem", margin: 0 }}>
            Sends Lightning sats off-chain, receives them on-chain. Restores receive capacity on the target channel.
          </p>

          <div>
            <label className="form-label">Amount (sats)</label>
            <input
              type="number"
              className="form-input"
              min={250000}
              step={10000}
              value={amount}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setAmount(val);
              }}
              placeholder="250000"
            />
          </div>

          <div>
            <label className="form-label">Channel ID (optional)</label>
            <input
              type="text"
              className="form-input"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="e.g. 867530x1234x0"
              style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
            />
            <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
              Target a specific channel. Leave empty to let the system choose.
            </p>
          </div>

          <div>
            <label className="form-label">Destination Address (optional)</label>
            <input
              type="text"
              className="form-input"
              value={destinationAddress}
              onChange={(e) => setDestinationAddress(e.target.value)}
              placeholder="bc1q... (leave empty for auto-generated)"
              style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
            />
            <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
              On-chain address to receive funds. If empty, the API generates a fresh address.
            </p>
          </div>

          {error && (
            <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            onClick={handleGetQuote}
            disabled={phase === "quoting"}
          >
            {phase === "quoting" ? "Getting quote..." : "Get Quote"}
          </button>
        </div>
      </div>
    );
  }

  // ─── Quote ────────────────────────────────────────────────────────────────
  if ((phase === "quoted" || phase === "initiating") && quoteResp) {
    const q = quoteResp.quote;
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">≡</span>Loop Out Quote
          </span>
          {countdown && (
            <span className={`badge ${countdown === "Expired" ? "badge-red" : "badge-amber"}`}>
              {countdown === "Expired" ? "Expired" : `Expires in ${countdown}`}
            </span>
          )}
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Amount</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.amount_sat)}</div>
            </div>
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Swap Fee</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.swap_fee_sat)}</div>
            </div>
            {q.prepay_sat != null && (
              <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
                <div className="stat-label">Prepay</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.prepay_sat)}</div>
              </div>
            )}
            {q.miner_fee_sat != null && (
              <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
                <div className="stat-label">Miner Fee</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.miner_fee_sat)}</div>
              </div>
            )}
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Total Fee</div>
              <div className="stat-value" style={{ fontSize: "1.125rem", color: "var(--amber)" }}>
                {fmtSats(q.total_fee_sat)}
              </div>
            </div>
          </div>

          {!quoteResp.policy_check.ok && (
            <div className="alert warning" style={{ marginBottom: 0 }}>
              <span className="alert-icon">⚠</span>
              <div className="alert-body">
                <div className="alert-msg">
                  {(quoteResp.policy_check as { reason: string }).reason}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleExecute}
              disabled={phase === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}
            >
              {phase === "initiating" ? "Executing..." : "Execute Loop Out"}
            </button>
            <button
              className="btn btn-outline"
              onClick={handleReset}
              disabled={phase === "initiating"}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Tracking ─────────────────────────────────────────────────────────────
  if (phase === "tracking" && trackingSwap) {
    const badge = statusBadge(trackingSwap.status);
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◎</span>Loop Out Status
          </span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
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
              New Loop Out
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ─── Loop In Tab ─────────────────────────────────────────────────────────────

function LoopInTab() {
  const [phase, setPhase] = useState<Phase>("form");
  const [amount, setAmount] = useState(250_000);
  const [error, setError] = useState<string | null>(null);

  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");

  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer
  useEffect(() => {
    if (phase === "quoted" && quoteResp?.swap_request.quote_expires_at) {
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
  }, [phase, quoteResp]);

  // Poll tracking
  useEffect(() => {
    if (phase === "tracking" && trackingId) {
      const poll = () => {
        api
          .adminGetSwap(trackingId)
          .then((detail) => {
            setTrackingSwap(detail.swap_request);
            if (isTerminal(detail.swap_request.status)) {
              if (pollRef.current) clearInterval(pollRef.current);
            }
          })
          .catch(() => {});
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [phase, trackingId]);

  async function handleGetQuote() {
    setError(null);
    if (amount < 250_000) {
      setError("Minimum swap is 250,000 sats");
      return;
    }
    setPhase("quoting");
    try {
      const resp = await api.adminLoopInQuote({ amount_sat: amount });
      setQuoteResp(resp);
      setPhase("quoted");
    } catch (e: any) {
      setError(e.message ?? "Failed to get quote");
      setPhase("form");
    }
  }

  async function handleExecute() {
    if (!quoteResp) return;
    setError(null);
    setPhase("initiating");
    try {
      const resp = await api.adminLoopIn({ swap_request_id: quoteResp.swap_request.id });
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setPhase("tracking");
    } catch (e: any) {
      setError(e.message ?? "Failed to execute Loop In");
      setPhase("quoted");
    }
  }

  function handleReset() {
    setPhase("form");
    setQuoteResp(null);
    setTrackingId(null);
    setTrackingSwap(null);
    setError(null);
    setCountdown("");
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // ─── Form ─────────────────────────────────────────────────────────────────
  if (phase === "form" || phase === "quoting") {
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↙</span>Loop In
          </span>
          <span className="badge badge-muted">restore outbound capacity</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p className="text-dim" style={{ fontSize: "0.8125rem", margin: 0 }}>
            Sends on-chain sats to the Loop server, receives them as Lightning. Restores outbound (sending) capacity.
          </p>

          <div>
            <label className="form-label">Amount (sats)</label>
            <input
              type="number"
              className="form-input"
              min={250000}
              step={10000}
              value={amount}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setAmount(val);
              }}
              placeholder="250000"
            />
          </div>

          {error && (
            <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            onClick={handleGetQuote}
            disabled={phase === "quoting"}
          >
            {phase === "quoting" ? "Getting quote..." : "Get Quote"}
          </button>
        </div>
      </div>
    );
  }

  // ─── Quote ────────────────────────────────────────────────────────────────
  if ((phase === "quoted" || phase === "initiating") && quoteResp) {
    const q = quoteResp.quote;
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">≡</span>Loop In Quote
          </span>
          {countdown && (
            <span className={`badge ${countdown === "Expired" ? "badge-red" : "badge-amber"}`}>
              {countdown === "Expired" ? "Expired" : `Expires in ${countdown}`}
            </span>
          )}
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Amount</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.amount_sat)}</div>
            </div>
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Swap Fee</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.swap_fee_sat)}</div>
            </div>
            {q.htlc_publish_fee_sat != null && (
              <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
                <div className="stat-label">HTLC Publish Fee</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(q.htlc_publish_fee_sat)}</div>
              </div>
            )}
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">Total Fee</div>
              <div className="stat-value" style={{ fontSize: "1.125rem", color: "var(--amber)" }}>
                {fmtSats(q.total_fee_sat)}
              </div>
            </div>
          </div>

          {!quoteResp.policy_check.ok && (
            <div className="alert warning" style={{ marginBottom: 0 }}>
              <span className="alert-icon">⚠</span>
              <div className="alert-body">
                <div className="alert-msg">
                  {(quoteResp.policy_check as { reason: string }).reason}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleExecute}
              disabled={phase === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}
            >
              {phase === "initiating" ? "Executing..." : "Execute Loop In"}
            </button>
            <button
              className="btn btn-outline"
              onClick={handleReset}
              disabled={phase === "initiating"}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Tracking ─────────────────────────────────────────────────────────────
  if (phase === "tracking" && trackingSwap) {
    const badge = statusBadge(trackingSwap.status);
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◎</span>Loop In Status
          </span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
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
              New Loop In
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ─── Swap History ────────────────────────────────────────────────────────────

function SwapHistory() {
  const [swaps, setSwaps] = useState<SwapRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSwaps = useCallback(() => {
    setLoading(true);
    api
      .adminSwapList(20)
      .then((r) => setSwaps(r.swaps))
      .catch(() => setSwaps([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSwaps();
  }, [loadSwaps]);

  return (
    <div className="panel fade-in" style={{ marginTop: 20 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">⟲</span>Swap History
        </span>
        {!loading && swaps.length > 0 && (
          <span className="badge badge-muted">{swaps.length}</span>
        )}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
            ))}
          </div>
        ) : swaps.length === 0 ? (
          <div className="empty-state" style={{ padding: "40px 20px" }}>
            No swaps yet. Execute a Loop Out or Loop In to get started.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Fee</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {swaps.map((s) => {
                  const sBadge = statusBadge(s.status);
                  const tBadge = typeBadge(s.swap_type);
                  return (
                    <tr key={s.id}>
                      <td className="text-dim" style={{ whiteSpace: "nowrap" }}>
                        {formatDate(s.created_at)}
                      </td>
                      <td>
                        <span className={`badge ${tBadge.cls}`}>{tBadge.label}</span>
                      </td>
                      <td className="td-num td-mono">{s.amount_sat.toLocaleString()}</td>
                      <td>
                        <span className={`badge ${sBadge.cls}`}>{sBadge.label}</span>
                      </td>
                      <td className="td-num td-mono">
                        {s.actual_fee_sat != null
                          ? s.actual_fee_sat.toLocaleString()
                          : s.quoted_fee_sat != null
                            ? `~${s.quoted_fee_sat.toLocaleString()}`
                            : "\u2014"}
                      </td>
                      <td className="text-dim">{s.role || "\u2014"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SwapOperations() {
  const [tab, setTab] = useState<Tab>("loop_out");

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Swap Operations</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Treasury Loop In and Loop Out swap management
        </p>
      </div>

      <div className="payment-tabs">
        <button
          className={`payment-tab ${tab === "loop_out" ? "active" : ""}`}
          onClick={() => setTab("loop_out")}
        >
          Loop Out
        </button>
        <button
          className={`payment-tab ${tab === "loop_in" ? "active" : ""}`}
          onClick={() => setTab("loop_in")}
        >
          Loop In
        </button>
      </div>

      {tab === "loop_out" ? <LoopOutTab /> : <LoopInTab />}

      <SwapHistory />
    </div>
  );
}
