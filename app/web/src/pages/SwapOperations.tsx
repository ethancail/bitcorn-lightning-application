import { useState, useEffect, useRef, useCallback } from "react";
import { api, fmtSats, resolveContactName, type Contact } from "../api/client";
import type { SwapRequest, SwapQuoteResponse } from "../api/client";
import { API_BASE } from "../config/api";
import ErrorState from "../components/ErrorState";
// Reusing the pure challenge helpers rather than the generic modal: this dialog
// is already stronger than the generic one (chunked address + verify checkbox),
// so swapping it out would lose those. Only the typed-amount gate was missing,
// and that logic stays in one place.
import { challengeSatisfied, challengePrompt } from "../components/actionConfirm/confirmAction";
import { classifyConfirmError } from "../components/actionConfirm/confirmErrors";
import {
  INITIAL_FRESHNESS,
  ageLabel,
  freshnessStatus,
  recordFailure,
  recordSuccess,
  type FreshnessState,
} from "../components/freshness";

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Phase = "form" | "quoting" | "quoted" | "initiating" | "tracking";

type ChannelInfo = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
  peerName: string;
  localPct: number;
};

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "initiated": return { label: "Processing", cls: "badge-amber" };
    case "executing": return { label: "In Progress", cls: "badge-amber" };
    case "confirming": return { label: "Confirming", cls: "badge-blue" };
    case "completed": return { label: "Complete", cls: "badge-green" };
    case "failed": return { label: "Failed", cls: "badge-red" };
    case "quoted": return { label: "Quoted", cls: "badge-muted" };
    case "expired": return { label: "Expired", cls: "badge-muted" };
    default: return { label: status, cls: "badge-muted" };
  }
}

function typeBadge(swapType: string): { label: string; cls: string } {
  if (swapType === "loop_out" || swapType === "loopout") return { label: "Loop Out", cls: "badge-amber" };
  if (swapType === "loop_in" || swapType === "loopin") return { label: "Loop In", cls: "badge-blue" };
  return { label: swapType, cls: "badge-muted" };
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "initiated": return "Swap initiated, processing...";
    case "executing": return "Swap in progress...";
    case "confirming": return "Confirming on-chain...";
    case "completed": return "Swap complete";
    case "failed": return `Swap failed${failureReason ? `: ${failureReason}` : ""}`;
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
  if (!epoch) return "\u2014";
  const d = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Lightweight client-side shape check for the custom Loop Out destination \u2014
// HRP prefix (bc/tb/bcrt) + bech32 charset + length. Full checksum validation
// happens server-side (bech32 package \u2192 400 invalid_destination_address); this
// only provides fast inline feedback before quoting.
const DEST_ADDRESS_FORMAT = /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{25,87}$/i;

function chunkAddress(addr: string): string {
  return addr.match(/.{1,4}/g)?.join(" ") ?? addr;
}

// ─── Channel Picker ─────────────────────────────────────────────────────────

function ChannelPicker({
  channels,
  selected,
  onSelect,
}: {
  channels: ChannelInfo[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (channels.length === 0) {
    return <div className="text-dim" style={{ fontSize: "0.8125rem" }}>No active channels available</div>;
  }

  const fmtCap = (s: number) => s >= 1_000_000 ? `${(s / 1_000_000).toFixed(1)}M` : `${(s / 1_000).toFixed(0)}k`;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {/* Auto chip */}
      <button
        onClick={() => onSelect("")}
        style={{
          padding: "10px 16px", borderRadius: 8, cursor: "pointer", border: "2px solid",
          borderColor: selected === "" ? "var(--amber)" : "var(--border)",
          background: selected === "" ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
          color: selected === "" ? "var(--amber)" : "var(--text-3)",
          fontFamily: "var(--mono)", fontSize: "0.8125rem", fontWeight: 600, minWidth: 100,
        }}
      >
        Auto
      </button>

      {/* Channel chips */}
      {channels.map((ch) => {
        const isSelected = selected === ch.channel_id;
        return (
          <button
            key={ch.channel_id}
            onClick={() => onSelect(ch.channel_id)}
            style={{
              padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: "2px solid",
              borderColor: isSelected ? "var(--amber)" : "var(--border)",
              background: isSelected ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
              display: "flex", flexDirection: "column", gap: 4, minWidth: 140, flex: "1 1 140px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: "0.8125rem", color: isSelected ? "var(--amber)" : "var(--text)" }}>
                {ch.peerName}
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
                {fmtCap(ch.capacity_sat)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-3)", overflow: "hidden" }}>
                <div style={{ width: `${ch.localPct}%`, height: "100%", background: isSelected ? "var(--amber)" : "var(--green)", borderRadius: 2 }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.625rem", color: "var(--text-3)" }}>
                {ch.localPct}%
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Formatted Amount Input ─────────────────────────────────────────────────

function AmountInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const PRESETS = [250_000, 500_000, 1_000_000, 2_000_000];
  return (
    <div>
      <label className="form-label">Amount</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            className={`btn ${value === preset ? "btn-primary" : "btn-outline"}`}
            style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}
            onClick={() => onChange(preset)}
          >
            {preset >= 1_000_000
              ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
              : `${(preset / 1_000).toFixed(0)}k`}
          </button>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <input
          className="form-input"
          type="text"
          inputMode="numeric"
          value={value > 0 ? value.toLocaleString() : ""}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            if (raw === "") { onChange(0); return; }
            onChange(Number(raw));
          }}
          style={{ paddingRight: 42 }}
        />
        <span style={{
          position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
          fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
        }}>sats</span>
      </div>
      {value > 0 && value < 250_000 && (
        <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
          Minimum swap is 250,000 sats.
        </div>
      )}
    </div>
  );
}

// ─── Loop Out Tab ────────────────────────────────────────────────────────────

function LoopOutTab({
  channels,
  channelsError,
  onRetryChannels,
}: {
  channels: ChannelInfo[];
  channelsError?: string | null;
  onRetryChannels?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("form");
  const [amount, setAmount] = useState(250_000);
  const [channelId, setChannelId] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [destTouched, setDestTouched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedAmount, setTypedAmount] = useState("");
  const [destVerified, setDestVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Destination is REQUIRED on the treasury manual path: the backend has no
  // auto-generate branch here (initiateSwap throws "Destination address
  // required" without a stored destination — pre-existing, surfaced in the
  // 2026-07-08 regtest pass). The auto-generate option is intentionally
  // removed from this UI until the backend fix lands as a separate regtested
  // pass; restore optional-empty gating and its copy then.
  const destTrimmed = destinationAddress.trim();
  const destValid = DEST_ADDRESS_FORMAT.test(destTrimmed);

  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);
  // U24 H5 (treasury): tracking-poll freshness — after 3 consecutive failed
  // polls the tracking panel says it can't confirm status instead of
  // spinning silently. Same treatment as the member Withdraw/Top Up pages.
  const [pollFresh, setPollFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase === "quoted" && quoteResp?.swap_request.quote_expires_at) {
      const expiresMs = quoteResp.swap_request.quote_expires_at < 1e12
        ? quoteResp.swap_request.quote_expires_at * 1000 : quoteResp.swap_request.quote_expires_at;
      const tick = () => {
        const remaining = expiresMs - Date.now();
        if (remaining <= 0) {
          setCountdown("Expired");
          setError("Quote has expired. Please get a new quote.");
          if (countdownRef.current) clearInterval(countdownRef.current);
        } else setCountdown(formatCountdown(expiresMs));
      };
      tick();
      countdownRef.current = setInterval(tick, 1000);
      return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
    }
  }, [phase, quoteResp]);

  useEffect(() => {
    if (phase === "tracking" && trackingId) {
      setPollFresh(INITIAL_FRESHNESS);
      const poll = () => {
        api.adminGetSwap(trackingId).then((d) => {
          setPollFresh((s) => recordSuccess(s, Date.now()));
          setTrackingSwap(d.swap_request);
          if (isTerminal(d.swap_request.status) && pollRef.current) clearInterval(pollRef.current);
        }).catch(() => setPollFresh(recordFailure));
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
  }, [phase, trackingId]);

  async function handleGetQuote() {
    setError(null);
    if (amount < 250_000) { setError("Minimum swap is 250,000 sats"); return; }
    setPhase("quoting");
    try {
      const body: { amount_sat: number; channel_id?: string } = { amount_sat: amount };
      if (channelId) body.channel_id = channelId;
      const resp = await api.adminLoopOutQuote(body);
      setQuoteResp(resp);
      setPhase("quoted");
    } catch (e: any) { setError(e.message ?? "Failed to get quote"); setPhase("form"); }
  }

  async function handleExecute() {
    if (!quoteResp) return;
    setError(null);
    setPhase("initiating");
    try {
      const body: { swap_request_id: string; destination_address?: string } = { swap_request_id: quoteResp.swap_request.id };
      if (destinationAddress.trim()) body.destination_address = destinationAddress.trim();
      const resp = await api.adminLoopOut(body);
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setPhase("tracking");
    } catch (e: any) {
      setPhase("quoted");
      // A confirmation refusal gets its own wording. A 409 here means the
      // dashboard and API disagree about this action, so the copy must not
      // read as a transient glitch the operator should retry.
      const cf = classifyConfirmError(e);
      setError(cf ? cf.title + " \u2014 " + cf.detail : (e.message ?? "Failed to execute"));
    }
  }

  function handleReset() {
    setPhase("form"); setQuoteResp(null); setTrackingId(null); setTrackingSwap(null);
    setError(null); setCountdown("");
    setConfirmOpen(false); setDestVerified(false); setDestTouched(false); setTypedAmount("");
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  if (phase === "form" || phase === "quoting") {
    const selectedChannel = channels.find((c) => c.channel_id === channelId);
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">↗</span>Loop Out</span>
          <span className="badge badge-muted">restore inbound capacity</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Channel picker — U24 H7: a failed channels fetch renders an error
             with retry, never the "No active channels available" fake-empty. */}
          <div>
            <label className="form-label">Channel</label>
            {channelsError != null && channels.length === 0 ? (
              <ErrorState
                bare
                message="Couldn't load channels."
                detail={channelsError}
                onRetry={() => onRetryChannels?.()}
              />
            ) : (
              <ChannelPicker channels={channels} selected={channelId} onSelect={setChannelId} />
            )}
          </div>

          <AmountInput value={amount} onChange={setAmount} />

          {/* Required field — not an "Advanced" expander: a control that gates
             Get Quote must be visible, or the disabled button reads as broken. */}
          <div>
            <label className="form-label">Destination address</label>
            <input
              type="text" className="form-input" value={destinationAddress}
              onChange={(e) => { setDestinationAddress(e.target.value); setDestVerified(false); }}
              onBlur={() => setDestTouched(true)}
              placeholder="bc1q…"
              style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
            />
            {destTouched && !destValid && (
              <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
                {destTrimmed === ""
                  ? "Enter the on-chain destination address for this Loop Out."
                  : "Not a valid bech32 address (bc1…)."}
              </div>
            )}
          </div>

          {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

          <button className="btn btn-primary" style={{ width: "100%" }} onClick={handleGetQuote}
            disabled={phase === "quoting" || amount < 250_000 || !destValid}>
            {phase === "quoting" ? "Getting quote..." : "Get Quote"}
          </button>
        </div>
      </div>
    );
  }

  if ((phase === "quoted" || phase === "initiating") && quoteResp) {
    const q = quoteResp.quote;
    const netFee = (q.swap_fee_sat ?? 0) + (q.miner_fee_sat ?? 0);
    return (
      <>
      {/* Execute confirmation — same dialog pattern as the ChannelsPage close-
         channel confirm. The operator-supplied destination renders in the
         warning register with a required verification checkbox gating the
         danger button. */}
      {confirmOpen && (
        <div className="dialog-overlay">
          <div className="dialog-card">
            <div className="dialog-title">Execute Loop Out?</div>
            <div className="dialog-body">
              This swaps <strong>{q.amount_sat.toLocaleString()} sats</strong> of channel balance
              into an on-chain payment. Estimated fee: ~{netFee.toLocaleString()} sats (swap + miner).
            </div>
            {/* Destination is always operator-supplied on this path (no
               auto-generate — see the note above destValid), so the warning
               register + verify checkbox is the only variant. */}
            <div className="alert warning" style={{ marginTop: 14, marginBottom: 0 }}>
              <span className="alert-icon">⚠</span>
              <div className="alert-body">
                <div className="alert-msg">
                  Funds will be sent on-chain to:
                  <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", margin: "6px 0", wordBreak: "break-all", color: "var(--text)" }}>
                    {chunkAddress(destTrimmed)}
                  </div>
                  On-chain sends cannot be reversed or refunded — a payment to a wrong address is unrecoverable.
                </div>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: "0.8125rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={destVerified}
                    onChange={(e) => setDestVerified(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  I have verified this address is correct
                </label>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <label htmlFor="swapops-typed-amount" style={{ display: "block", marginBottom: 6, fontSize: "0.8125rem" }}>
                {challengePrompt({ kind: "amount", sats: q.amount_sat })}
              </label>
              <input
                id="swapops-typed-amount"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={typedAmount}
                onChange={(e) => setTypedAmount(e.target.value)}
                style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => { setConfirmOpen(false); setTypedAmount(""); }}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={!destVerified || !challengeSatisfied({ kind: "amount", sats: q.amount_sat }, typedAmount)}
                onClick={() => { setConfirmOpen(false); setTypedAmount(""); handleExecute(); }}
              >
                Execute Loop Out
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">≡</span>Loop Out Quote</span>
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
              <div className="stat-label">Estimated Fee</div>
              <div className="stat-value" style={{ fontSize: "1.125rem" }}>~{fmtSats(netFee)}</div>
              <div style={{ fontSize: "0.6875rem", color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                Swap: {fmtSats(q.swap_fee_sat ?? 0)} + Miner: {fmtSats(q.miner_fee_sat ?? 0)}
              </div>
            </div>
            <div className="stat-card" style={{ flex: 1, minWidth: 130 }}>
              <div className="stat-label">You Receive On-Chain</div>
              <div className="stat-value" style={{ fontSize: "1.125rem", color: "var(--green)" }}>~{fmtSats(q.amount_sat - netFee)}</div>
            </div>
          </div>

          {q.prepay_sat != null && q.prepay_sat > 0 && (
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", padding: "6px 10px", background: "var(--bg-3)", borderRadius: 6 }}>
              Prepay hold: {fmtSats(q.prepay_sat)} — temporary, returned in the on-chain payment.
            </div>
          )}

          {!quoteResp.policy_check.ok && (
            <div className="alert warning" style={{ marginBottom: 0 }}>
              <span className="alert-icon">⚠</span>
              <div className="alert-body"><div className="alert-msg">{(quoteResp.policy_check as any).reason}</div></div>
            </div>
          )}
          {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }}
              onClick={() => { setDestVerified(false); setConfirmOpen(true); }}
              disabled={phase === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}>
              {phase === "initiating" ? "Executing..." : "Execute Loop Out"}
            </button>
            <button className="btn btn-outline" onClick={handleReset} disabled={phase === "initiating"}>Cancel</button>
          </div>
        </div>
      </div>
      </>
    );
  }

  if (phase === "tracking" && trackingSwap) {
    const badge = statusBadge(trackingSwap.status);
    return (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◎</span>Loop Out Status</span>
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
          <div style={{ padding: "10px 14px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: 8, fontSize: "0.875rem",
            color: trackingSwap.status === "failed" ? "var(--red)" : "var(--text-2)" }}>
            {statusText(trackingSwap.status, trackingSwap.failure_reason)}
            {!isTerminal(trackingSwap.status) && (
              <span className="loading-shimmer" style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", marginLeft: 8, verticalAlign: "middle" }} />
            )}
          </div>
          {/* U24 H5: status polls failing — say so instead of spinning silently. */}
          {!isTerminal(trackingSwap.status) && freshnessStatus(pollFresh, true) === "stale" && (
            <div className="alert warning" style={{ marginBottom: 0 }}>
              <span className="alert-icon">⚠</span>
              <div className="alert-body">
                <div className="alert-msg">
                  Can't confirm the swap status right now — last update{" "}
                  {pollFresh.lastSuccessAt != null ? ageLabel(pollFresh.lastSuccessAt, Date.now()) : "unavailable since this page loaded"}.
                  Retrying automatically; the swap continues server-side either way.
                </div>
              </div>
            </div>
          )}
          {isTerminal(trackingSwap.status) && (
            <button className="btn btn-outline" onClick={handleReset} style={{ alignSelf: "flex-start" }}>New Loop Out</button>
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
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadSwaps = useCallback(() => {
    setLoading(true);
    api.adminSwapList(20)
      .then((r) => { setSwaps(r.swaps); setHistoryError(null); })
      // U24 H7: keep last-good rows on failure — never clear to [] (which
      // rendered as "No swaps yet." on a fetch failure).
      .catch((e: any) => setHistoryError(e?.detail ?? e?.message ?? "fetch failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSwaps(); }, [loadSwaps]);

  return (
    <div className="panel fade-in" style={{ marginTop: 20 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟲</span>Swap History</span>
        {!loading && swaps.length > 0 && <span className="badge badge-muted">{swaps.length}</span>}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3].map((i) => <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />)}
          </div>
        ) : historyError != null && swaps.length === 0 ? (
          <div style={{ padding: "16px 20px" }}>
            <ErrorState
              bare
              message="Couldn't load swap history."
              detail={historyError}
              onRetry={loadSwaps}
            />
          </div>
        ) : swaps.length === 0 ? (
          <div className="empty-state" style={{ padding: "40px 20px" }}>No swaps yet.</div>
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
                  const sb = statusBadge(s.status);
                  const tb = typeBadge(s.swap_type);
                  return (
                    <tr key={s.id}>
                      <td>{formatDate(s.created_at)}</td>
                      <td><span className={`badge ${tb.cls}`}>{tb.label}</span></td>
                      <td className="td-num td-mono">{s.amount_sat.toLocaleString()}</td>
                      <td><span className={`badge ${sb.cls}`}>{sb.label}</span></td>
                      <td className="td-num td-mono">
                        {s.actual_fee_sat != null ? s.actual_fee_sat.toLocaleString()
                          : s.quoted_fee_sat != null ? `~${s.quoted_fee_sat.toLocaleString()}` : "\u2014"}
                      </td>
                      <td style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>{s.role}</td>
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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SwapOperations() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);

  const loadChannels = useCallback(() => {
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Promise<any[]>,
      api.getContacts().catch(() => [] as Contact[]),
    ]).then(([chs, contacts]) => {
      setChannels(
        chs.filter((c: any) => c.active === 1).map((c: any) => ({
          ...c,
          peerName: resolveContactName(c.peer_pubkey, contacts),
          localPct: c.capacity_sat > 0 ? Math.round((c.local_balance_sat / c.capacity_sat) * 100) : 0,
        }))
      );
      setChannelsError(null);
    }).catch((e: any) => {
      // U24 H7: the channels fetch was uncaught — an API hiccup rendered
      // "No active channels available" on the real-money swap form.
      setChannelsError(e?.detail ?? e?.message ?? "fetch failed");
    });
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Swap Operations</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Treasury Loop Out swap management
        </p>
      </div>

      {/* Treasury Loop In tab removed — deprecated flow (backend returns 410).
         Treasury maintains inbound via Loop Out on external channels; member-side
         Loop In (merchant refill) lives in RefillChannel.tsx. */}
      <LoopOutTab channels={channels} channelsError={channelsError} onRetryChannels={loadChannels} />

      <SwapHistory />
    </div>
  );
}
