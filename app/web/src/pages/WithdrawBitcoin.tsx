import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtSats, swapExecuteBody, transfersApi, type SwapOptions } from "../api/client";
import { OptionCards } from "../components/OptionCards";
import { rateNote } from "../api/rate";
import type { ExchangeRate, SwapLimits } from "../api/client";
import type { SwapRequest, SwapQuoteResponse, MemberLiquidityStatusResponse, SwapReceipt } from "../api/client";
import ErrorState from "../components/ErrorState";
import TechnicalDetails, { TechRow } from "../components/TechnicalDetails";
import { capacityTone, capacityRoomWord, CAPACITY_BAR_COLOR, CAPACITY_TEXT_COLOR } from "../components/capacityTone";
import { statusBadge, memberSwapBadge } from "../components/swapStatus";
import { loopFailureSentence } from "../components/loopFailureCopy";
import ActionConfirmModal, {
  useActionConfirm,
} from "../components/actionConfirm/ActionConfirmModal";
import {
  summarizeLoopOut,
  authorizedMaxSats,
  loopOutEstimatedFeeSats,
} from "../components/actionConfirm/confirmAction";
import { classifyConfirmError, memberSwapErrorText } from "../components/actionConfirm/confirmErrors";
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

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

// Plain-language status per the 2026-07-09 vocabulary record (U1/U2). The
// protocol-register originals live in statusTechnical below — demoted into
// the Technical details expander, not deleted. Neither returns a raw status:
// anything they don't name reads as its badge label from the shared map
// (humanized if unknown).
// Exported for the 'initiating' mapping test (swapStatus.initiating.test.ts).
export function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "quote_created": return "Quote received. The withdrawal hasn't started yet.";
    case "initiating": return "Starting…";
    case "initiated": return "Starting your withdrawal...";
    case "executing": return "Sending funds to your Bitcoin address...";
    case "confirming": return "Waiting for Bitcoin network confirmation...";
    case "completed": return "Withdrawal complete";
    // drive-mode P2 item 7: the member-facing sentence, never loopd's raw code
    // (which stays in Technical details).
    // R33 finding 9: a temporary failure is not final, so it says so.
    case "failed": return `${failureReason === "FAILURE_REASON_TEMPORARY" ? "Withdrawal not finished." : "Withdrawal failed."} ${loopFailureSentence(failureReason, "loop_out")}`;
    default: return statusBadge(status).label;
  }
}

// The Protocol status row: the protocol status beside its description.
export function statusTechnical(status: string): string {
  switch (status) {
    case "initiating": return "initiating — Checking fees and route before the swap starts";
    case "initiated": return "initiated — Paying Lightning invoice to Loop server";
    case "executing": return "executing — Loop server publishing on-chain HTLC";
    case "confirming": return "confirming — Waiting for on-chain confirmation";
    default: return statusBadge(status).label;
  }
}

/**
 * The Withdraw panel's prepay sentence and its fee breakdown. The prepay is an
 * advance on the principal, counted toward the amount withdrawn — not a fee
 * (Polar gate 1's L3); label and sentence are P12 p's,
 * verbatim. Exported for its render test (WithdrawBitcoin.prepay.test.tsx).
 */
export function QuoteFeeDetails({ swapFee, minerFee, prepay }: { swapFee: number; minerFee: number; prepay: number }) {
  return (
    <>
      {prepay > 0 && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", padding: "8px 12px", background: "var(--bg-3)", borderRadius: 6 }}>
          Paid to the swap service up front and counted toward the amount you withdraw — not an extra fee.
          If the withdrawal fails after it starts, the prepay may not be refunded.
        </div>
      )}
      {/* Protocol fee breakdown — demoted per U2/Knot 3 */}
      <TechnicalDetails>
        {swapFee > 0 && <TechRow label="Swap service fee">{fmtSats(swapFee)}</TechRow>}
        {minerFee > 0 && <TechRow label="Bitcoin network (miner) fee">{fmtSats(minerFee)}</TechRow>}
        {prepay > 0 && <TechRow label="Prepay (part of your withdrawal)">{fmtSats(prepay)}</TechRow>}
      </TechnicalDetails>
    </>
  );
}

/**
 * A completed swap's fee receipt (drive-mode P2 item 14; D2.6): the summary,
 * dollars first with the sats underneath, and the breakdown behind a dropdown.
 * The parts are the server's (GET /api/swaps/:id receipt) and sum to its
 * total. Page-local on purpose, as RefillChannel's copy is: a shared component
 * is member-first-run-ui's to build (spec §1.3).
 */
/** US cents as dollars: 300 → "$3.00". */
function centsText(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function FeeReceipt({ receipt, usdCents }: { receipt: SwapReceipt; usdCents: number | null | undefined }) {
  // Drive-mode P3 (R40(5)): a past record's dollars are the ones STORED at
  // completion (actual_fee_usd_cents, written only with a fresh rate); without
  // them, sats — never today's price (the amount component spec §1.1).
  const dollars = usdCents != null ? centsText(usdCents) : null;
  const parts: Array<[string, number]> = [
    ["Swap service fee", receipt.swap_fee_sat],
    ["Bitcoin network fee", receipt.network_fee_sat],
    ["Lightning routing", receipt.routing_fee_sat],
  ];
  return (
    <div data-testid="fee-receipt" style={{ maxWidth: 320 }}>
      <div className="stat-label">Fee</div>
      <div className="stat-value" style={{ fontSize: "1.125rem" }} data-testid="fee-summary">
        {dollars ?? fmtSats(receipt.total_sat)}
      </div>
      {dollars && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }} data-testid="fee-summary-sats">
          {fmtSats(receipt.total_sat)}
        </div>
      )}
      <details style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 6 }}>
        <summary style={{ cursor: "pointer", userSelect: "none" }}>Fee breakdown</summary>
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {parts.map(([label, sats]) => (
            <div key={label} data-testid="fee-part" data-sats={sats} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>{label}</span>
              <span style={{ fontFamily: "var(--mono)" }}>{fmtSats(sats)}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
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
  const [searchParams] = useSearchParams();
  const advisorAmount = Number(searchParams.get("amount")) || 0;

  // ─── Address state (generated on load) ──────────────────────────────────
  const [address, setAddress] = useState<string | null>(null);
  const [addressLoading, setAddressLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // ─── Form state ───────────────────────────────────────────────────────
  const [stage, setStage] = useState<Stage>("loading");
  const [amount, setAmount] = useState(advisorAmount || 0);
  // The effective Loop Out limits, read from the server (drive-mode P1 item 6):
  // the stricter of the env limits and loopd's live terms.
  const [limits, setLimits] = useState<SwapLimits | null>(null);
  const minW = limits?.loop_out?.min_sats ?? null;
  const maxW = limits?.loop_out?.max_sats ?? null;
  // What can be withdrawn now and pass the pre-quote policy (drive-mode P1
  // item 7): the server's figure — the effective maximum, today's remaining
  // daily amount and the channel less the swap-only buffer.
  const availableNow = limits?.loop_out?.available_now_sats ?? null;
  const canWithdraw = minW != null && availableNow != null && availableNow >= minW;
  // Whether the hub channel is up (drive-mode P3): stats fall back to the
  // largest inactive hub channel for display (R18(2)), and the server refuses
  // every Loop Out while it is down, so the page says why rather than blaming
  // the balance. null until stats arrive.
  const [hubActive, setHubActive] = useState<boolean | null>(null);
  // GET /api/swaps/options (drive-mode P3): null until read, or on failure.
  const [options, setOptions] = useState<SwapOptions | null>(null);
  const [optionsDone, setOptionsDone] = useState(false);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // ─── Quote state ──────────────────────────────────────────────────────
  const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
  const [countdown, setCountdown] = useState("");

  // ─── Tracking state ───────────────────────────────────────────────────
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);
  // The completed swap's fee receipt, from GET /api/swaps/:id (drive-mode P2
  // item 14).
  const [trackingReceipt, setTrackingReceipt] = useState<SwapReceipt | null>(null);

  // ─── History state ────────────────────────────────────────────────────
  const [history, setHistory] = useState<SwapRequest[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // BTC/USD for the fee $ estimate — same source + null→sats-only degrade as
  // the dashboard (Knot 3, vocabulary record 2026-07-09; Coinbase spot via
  // /api/exchange-rate).
  const [usdRate, setUsdRate] = useState<number | null>(null);
  // The rate's state, for its note (drive-mode P1 item 3).
  const [rateInfo, setRateInfo] = useState<ExchangeRate | null>(null);
  // U24 H5: tracking-poll freshness — after 3 consecutive failed polls the
  // tracking panel says it can't confirm status instead of spinning silently.
  const [pollFresh, setPollFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [expandedSwapId, setExpandedSwapId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<{ swap_request: SwapRequest; execution: any; events: any[]; receipt?: SwapReceipt | null } | null>(null);

  // ─── Max withdrawable from treasury channel ─────────────────────────
  const [channelLocal, setChannelLocal] = useState<number | null>(null);
  const [channelCapacity, setChannelCapacity] = useState<number | null>(null);
  const [channelLocalPct, setChannelLocalPct] = useState<number | null>(null);
  // V11: the bar's colour is the Liquidity Advisor's state, not a percentage.
  const [advisor, setAdvisor] = useState<MemberLiquidityStatusResponse | null>(null);
  const role = advisor?.channelRole ?? advisor?.classification?.channelRole ?? "unknown";
  const tone = capacityTone(role, advisor?.classification);
  // R33 finding 7: the bar is the share in the connection, not the room, so
  // the warning names the room it is about.
  const toneWord = capacityRoomWord(role, tone);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The advisor read: the bar's colour, and the Loop alert (drive-mode P2 item
  // 6), whose action re-reads it.
  function loadAdvisor() {
    api.getMemberLiquidityStatus().then(setAdvisor).catch(() => {});
  }

  // ─── Fetch max withdrawable from treasury channel ──────────────────────
  useEffect(() => {
    api.getMemberStats()
      .then((s) => {
        if (s.treasury_channel) {
          setHubActive(s.treasury_channel.is_active);
          setChannelLocal(s.treasury_channel.local_sats);
          setChannelCapacity(s.treasury_channel.capacity_sats);
          setChannelLocalPct(
            s.treasury_channel.capacity_sats > 0
              ? Math.round((s.treasury_channel.local_sats / s.treasury_channel.capacity_sats) * 100)
              : 0
          );
        }
      })
      .catch(() => {});
    api.getSwapLimits()
      .then((l) => {
        setLimits(l);
        // The default amount (the advisor's, else the effective minimum) is
        // offered only if the policy would accept it now; otherwise none.
        const min = l?.loop_out?.min_sats;
        const now = l?.loop_out?.available_now_sats;
        setAmount((a) =>
          min == null || now == null || now < min ? 0 : a >= min && a <= now ? a : min,
        );
      })
      .catch(() => {});
    loadAdvisor();
    // Drive-mode P3: the option cards and the quote-based Max (read-only).
    transfersApi.getSwapOptions("loop_out")
      .then(setOptions)
      .catch(() => setOptions(null))
      .finally(() => setOptionsDone(true));
  }, []);

  // Most you can withdraw, and the Max button (drive-mode P3, R25): the
  // QUOTE-BASED maximum — available_now less today's quoted fee, re-quoted,
  // so a Loop Out of exactly Max passes execute's amount + fee ≤ room check.
  // While the quote is out, Max says it is checking; if loopd can't quote, it
  // falls back to available_now and keeps the R25 sentence.
  const nowCard = options?.state === "ok" ? options.cards.find((c) => c.key === "now") ?? null : null;
  const quoteBased = options?.quote_state === "ok" && nowCard?.amount_sats != null;
  const maxWithdrawable = !canWithdraw ? null : quoteBased ? nowCard!.amount_sats! : optionsDone ? availableNow : null;
  const checkingFees = canWithdraw && !optionsDone;
  // Presets the policy would accept now; none when nothing can be withdrawn.
  const presets = canWithdraw ? AMOUNT_PRESETS.filter((p) => p >= minW! && p <= (maxWithdrawable ?? availableNow!)) : [];

  // ─── Pending swap detection ───────────────────────────────────────────
  useEffect(() => {
    api.getSwapHistory(5).then((r) => {
      const inflight = r.swaps.find(
        (s) => s.swap_type === "loop_out" && !["completed", "failed", "expired"].includes(s.status)
      );
      if (inflight) {
        setTrackingId(inflight.id);
        setTrackingSwap(inflight);
        setStage("tracking");
      } else {
        setStage("form");
      }
    }).catch(() => setStage("form"));
  }, []);

  // ─── Generate address on mount ────────────────────────────────────────
  useEffect(() => {
    generateAddress();
    loadHistory();
    api.getExchangeRate().then((r) => { setRateInfo(r); setUsdRate(r.usd); }).catch(() => {});
  }, []);

  const toUsd = (sats: number) =>
    usdRate ? `$${((sats / 100_000_000) * usdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

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
      .then((r) => { setHistory(r.swaps); setHistoryError(null); })
      // U24 H4: keep last-good rows on failure — never clear to [] (which
      // rendered as "No withdrawals yet" while a swap could be in flight).
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
      return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
    }
  }, [stage, quoteResp]);

  // ─── Poll tracking status ─────────────────────────────────────────────
  useEffect(() => {
    if (stage === "tracking" && trackingId) {
      setPollFresh(INITIAL_FRESHNESS);
      const poll = () => {
        api.getSwap(trackingId)
          .then((detail) => {
            setPollFresh((s) => recordSuccess(s, Date.now()));
            setTrackingSwap(detail.swap_request);
            setTrackingReceipt(detail.receipt ?? null);
            if (isTerminal(detail.swap_request.status)) {
              if (pollRef.current) clearInterval(pollRef.current);
              loadHistory();
            }
          })
          .catch(() => setPollFresh(recordFailure));
      };
      poll();
      pollRef.current = setInterval(poll, 15_000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
  }, [stage, trackingId]);

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
    if (amount <= 0) { setError("Enter an amount"); return; }
    if (minW != null && amount < minW) { setError(`Minimum withdrawal is ${minW.toLocaleString()} sats`); return; }
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
      setError(memberSwapErrorText(e, "Failed to get quote"));
      setStage("form");
    }
  }

  // ─── Confirm withdrawal ───────────────────────────────────────────────
  // The destination address is the field a mistake ruins irrecoverably, so the
  // modal shows it and requires the amount typed. apiFetch derives the
  // x-bitcorn-confirm header from the serialized body.
  const confirm = useActionConfirm();

  function openWithdrawConfirm() {
    if (!quoteResp || !address) return;
    confirm.open(
      summarizeLoopOut({
        amountSats: quoteResp.quote.amount_sat,
        destinationAddress: address,
        // The same estimate the quote panel shows (loop-fee-ceilings §7).
        feeSats: loopOutEstimatedFeeSats(quoteResp.quote),
        authorizedMaxSats: authorizedMaxSats(quoteResp.ceilings),
      }),
    );
  }

  async function handleConfirm() {
    if (!quoteResp || !address) return;
    setError(null);
    setStage("initiating");
    try {
      // The shared builder echoes the quote's ceilings unchanged (F4).
      const resp = await api.initiateSwapLoopOut(
        swapExecuteBody(quoteResp, {
          swap_request_id: quoteResp.swap_request.id,
          destination_address: address,
        }),
      );
      setTrackingId(resp.swap_request.id);
      setTrackingSwap(resp.swap_request);
      setStage("tracking");
    } catch (e: any) {
      setStage("quoted");
      if (classifyConfirmError(e)) throw e;
      setError(memberSwapErrorText(e, "Failed to initiate withdrawal"));
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

  if (stage === "loading") {
    return (
      <div>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ marginBottom: 4 }}>Withdraw Bitcoin</h1>
          <p className="text-dim" style={{ fontSize: "0.875rem" }}>
            Move funds from Bitcorn to a Bitcoin wallet
          </p>
        </div>
        <div className="loading-shimmer" style={{ height: 200, borderRadius: 8 }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Withdraw Bitcoin</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Move funds from Bitcorn to a Bitcoin wallet
        </p>
        {rateNote(rateInfo) && (
          <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{rateNote(rateInfo)}</p>
        )}
      </div>

      {/* drive-mode P2 item 6 (D2.3): Loop unavailable for withdrawals — the
          API's loop_out sentence, verbatim (2026-09-02 D2(b)), one action. */}
      {advisor?.loopAlert?.loop_out && (
        <div className="alert warning">
          <span className="alert-icon" aria-hidden>⚠</span>
          <div className="alert-body">
            <div className="alert-msg">{advisor.loopAlert.loop_out.text}</div>
            <button className="btn btn-outline alert-action" onClick={loadAdvisor}>
              {advisor.loopAlert.loop_out.action.label}
            </button>
          </div>
        </div>
      )}

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
              <label className="form-label">Amount</label>
              {channelLocalPct != null && (
                <div style={{
                  background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
                  padding: "10px 14px", marginBottom: 10,
                }}>
                  {/* drive-mode P2 item 15 (R26(8)): the bar is local /
                      capacity, a share of the connection; it no longer claims
                      that share can be withdrawn ("Most you can withdraw" is
                      the server's figure). */}
                  <div style={{ fontSize: "0.75rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 4 }}>
                    In your connection
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
                      <div data-testid="capacity-bar" style={{ width: `${Math.min(channelLocalPct, 100)}%`, height: "100%", background: CAPACITY_BAR_COLOR[tone] }} />
                    </div>
                    <span data-testid="capacity-text" style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: CAPACITY_TEXT_COLOR[tone] }}>
                      {toneWord && `${toneWord} · `}{channelLocalPct}% of your connection
                    </span>
                  </div>
                </div>
              )}
              {channelLocal != null && (
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                  padding: "10px 14px", marginBottom: 10, borderRadius: 8,
                  background: "color-mix(in srgb, var(--amber) 8%, var(--bg-2))",
                  border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
                }}>
                  <div>
                    <div style={{ fontSize: "0.75rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
                      In your connection
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "1.125rem", fontWeight: 600, color: "var(--text)", lineHeight: 1.2 }}>
                      {channelLocal.toLocaleString()}
                      <span style={{ fontSize: "0.75rem", color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>sats</span>
                    </div>
                  </div>
                  {maxWithdrawable != null && minW != null && maxWithdrawable >= minW && (
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "0.75rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
                        Most you can withdraw
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", color: "var(--text-2)" }}>
                        {maxWithdrawable.toLocaleString()} sats
                      </div>
                    </div>
                  )}
                </div>
              )}
              {/* drive-mode P2 item 16 (R11(4)): what always stays, Withdraw
                  only, one tap down. "Why not all of it?" (R27(7)) until P4
                  makes it a timing question. The figures are the server's
                  (GET /api/swaps/limits loop_out.always_stays); its parts sum
                  to its total. */}
              {limits?.loop_out?.always_stays && (() => {
                const a = limits.loop_out.always_stays;
                const rows: Array<[string, number]> = [
                  ["Always stays to keep you connected", a.total_sats],
                  ["Connection reserve", a.reserve_sats],
                  ["Lightning fee headroom", a.fee_headroom_sats],
                  ["Swap buffer", a.swap_buffer_sats],
                ];
                return (
                  <details style={{ fontSize: "0.75rem", color: "var(--text-2)", marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer", userSelect: "none" }}>Why not all of it?</summary>
                    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                      {rows.map(([label, sats], i) => (
                        <div key={label} data-testid="always-stays-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, fontWeight: i === 0 ? 600 : 400 }}>
                          <span>{label}</span>
                          <span style={{ fontFamily: "var(--mono)" }}>{sats.toLocaleString()} sats</span>
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })()}
              {/* Drive-mode P3 (gate 2): when nothing can move there is no
                  amount to choose — no input, placeholder, presets or
                  after-line, only the sentence below. */}
              {canWithdraw && (<>
              {/* Drive-mode P3: the option cards. They only pre-fill the
                  amount below; the quote and its confirmation are unchanged. */}
              {options && (
                <div style={{ marginBottom: 12 }}>
                  <OptionCards
                    options={options}
                    usd={rateInfo?.state === "none" ? null : usdRate}
                    onUse={(sats) => setAmount(sats)}
                    onLeave={() => navigate("/dashboard")}
                    onDeposit={() => navigate("/deposit")}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                {presets.map((preset) => (
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
                {maxWithdrawable != null && maxWithdrawable > 0 && (
                  <button
                    className={`btn ${amount === maxWithdrawable ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto", fontWeight: 600 }}
                    onClick={() => setAmount(maxWithdrawable)}
                    title={`${maxWithdrawable.toLocaleString()} sats`}
                  >
                    Max
                  </button>
                )}
                {checkingFees && (
                  <button className="btn btn-outline" disabled style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}>
                    Checking today's fees…
                  </button>
                )}
              </div>
              {maxWithdrawable != null && maxWithdrawable > 0 && (
                <p className="text-dim" data-testid="max-fee-note" style={{ fontSize: "0.75rem", marginTop: 0, marginBottom: 8 }}>
                  {quoteBased
                    ? "This allows for today's fees; if they rise before you confirm, the quote will say so."
                    : "The swap's fees come out of this, so the exact amount you can withdraw is set when you get a quote."}
                </p>
              )}
              <div style={{ position: "relative" }}>
                <input
                  aria-label="Amount"
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
              {channelLocal != null && channelCapacity != null && channelCapacity > 0 && (
                <div style={{ background: "var(--bg-2)", borderLeft: "2px solid var(--amber)", padding: 8, fontSize: "0.75rem", color: "var(--text-2)", marginBottom: 10 }}>
                  After withdrawal: <strong data-testid="capacity-text" style={{ color: "var(--text)" }}>
                    {channelLocalPct}% → {Math.max(0, Math.round(((channelLocal - amount) / channelCapacity) * 100))}% of your connection
                  </strong>
                </div>
              )}
              </>)}
              {minW != null && maxW != null && (
                <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                  Minimum: {minW.toLocaleString()} sats. Maximum: {maxW.toLocaleString()} sats.
                </p>
              )}
              {minW != null && availableNow != null && !canWithdraw && (() => {
                const stays = limits?.loop_out?.always_stays ?? null;
                const dailyLeft = limits?.loop_out?.daily_remaining_sats ?? null;
                // One sentence, the binding cause first: the connection is
                // down (the server refuses every Loop Out), today's limit is
                // used, or too little is waiting — the minimum plus what
                // always stays (the server's figure).
                const sentence =
                  hubActive === false
                    ? "Your connection to Bitcorn is down, so payments can't go through it right now. It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app."
                    : dailyLeft != null && dailyLeft < minW
                      ? "You've withdrawn as much as the daily limit allows. It frees up over the next 24 hours."
                      : stays
                        ? `You can move ${minW.toLocaleString()} sats once ${(minW + stays.total_sats).toLocaleString()} sats is waiting in your connection.`
                        : `Not enough in your connection to withdraw right now — the minimum is ${minW.toLocaleString()} sats.`;
                return (
                  <div data-testid="withdraw-nothing-movable" style={{ fontSize: "0.75rem", color: "var(--text-2)", marginTop: 4 }}>
                    {sentence}
                  </div>
                );
              })()}
              {canWithdraw && amount > availableNow! && (
                <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
                  The most you can withdraw right now is {availableNow!.toLocaleString()} sats.
                </div>
              )}
              {minW != null && amount > 0 && amount < minW && (
                <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
                  Withdrawal must be at least {minW.toLocaleString()} sats.
                </div>
              )}
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
                      fontFamily: "var(--font-id)",
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
              <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                Your withdrawn bitcoin will be sent to this on-chain address.
              </p>
            </div>

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleGetQuote}
              disabled={stage === "quoting" || addressLoading || !address || !canWithdraw || amount < minW! || amount > availableNow!}
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
              <span className={`badge ${countdown === "Expired" ? "badge-muted" : "badge-amber"}`}>
                {countdown === "Expired" ? "Expired" : `Expires in ${countdown}`}
              </span>
            )}
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(() => {
              const q = quoteResp.quote;
              const swapFee = q.swap_fee_sat ?? 0;
              const minerFee = q.miner_fee_sat ?? 0;
              const netFee = loopOutEstimatedFeeSats(q);
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
                      {toUsd(netFee) && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
                          (~{toUsd(netFee)})
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
                  <QuoteFeeDetails swapFee={swapFee} minerFee={minerFee} prepay={prepay} />
                </div>
              );
            })()}

            <div style={{ fontFamily: "var(--font-id)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
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
                onClick={openWithdrawConfirm}
                disabled={stage === "initiating" || countdown === "Expired" || !quoteResp.policy_check.ok}
              >
                {stage === "initiating" ? "Processing..." : "Confirm Withdrawal"}
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
              <span className="icon">◎</span>Withdrawal Status
            </span>
            <span className={`badge ${memberSwapBadge(trackingSwap.status, trackingSwap.failure_reason).cls}`}>
              {memberSwapBadge(trackingSwap.status, trackingSwap.failure_reason).label}
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                <div className="stat-label">Amount</div>
                <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(trackingSwap.amount_sat)}</div>
              </div>
              {trackingReceipt ? (
                <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                  <FeeReceipt receipt={trackingReceipt} usdCents={trackingSwap.actual_fee_usd_cents} />
                </div>
              ) : trackingSwap.actual_fee_sat != null && (
                <div className="stat-card" style={{ flex: 1, minWidth: 140 }}>
                  <div className="stat-label">Actual Fee</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>{fmtSats(trackingSwap.actual_fee_sat)}</div>
                </div>
              )}
            </div>

            {trackingSwap.destination_address && (
              <div style={{ fontFamily: "var(--font-id)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
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

            {!isTerminal(trackingSwap.status) && (
              <TechnicalDetails>
                <TechRow label="Protocol status">
                  {statusTechnical(trackingSwap.status)}
                </TechRow>
              </TechnicalDetails>
            )}
            {trackingSwap.failure_reason && (
              <TechnicalDetails>
                <TechRow label="Failure code">{trackingSwap.failure_reason}</TechRow>
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
          ) : historyError !== null && history.length === 0 ? (
            <ErrorState
              bare
              message="Couldn't load your withdrawal history."
              detail={historyError}
              onRetry={loadHistory}
            />
          ) : history.length === 0 ? (
            <div className="empty-state">No withdrawals yet</div>
          ) : (
            // R34 item 4: Top Up's phone layout (.phone-fit, styles.css X4c) —
            // the same columns, so the same markup: one line where every row
            // fits, a card otherwise; never a sideways scroll on a phone.
            <div className="table-scroll phone-fit-wrap">
              <table className="data-table phone-fit">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Status</th>
                    <th className="col-secondary" style={{ textAlign: "right" }}>Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((s) => {
                    const badge = memberSwapBadge(s.status, s.failure_reason);
                    const isExpanded = expandedSwapId === s.id;
                    return (
                      <React.Fragment key={s.id}>
                        <tr
                          onClick={() => handleExpandSwap(s.id)}
                          style={{ cursor: "pointer", background: isExpanded ? "color-mix(in srgb, var(--amber) 6%, transparent)" : undefined }}
                        >
                          <td className="td-primary">{formatDate(s.created_at)}</td>
                          <td data-label="Amount" className="td-num td-mono">{s.amount_sat.toLocaleString()}</td>
                          <td data-label="Status"><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                          <td data-label="Fee" className="td-num td-mono col-secondary">
                            {s.actual_fee_sat != null
                              ? (s.actual_fee_usd_cents != null
                                  // Drive-mode P3 (R40(5)): the stored dollars, sats beneath.
                                  ? <><div>{centsText(s.actual_fee_usd_cents)}</div><div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>{s.actual_fee_sat.toLocaleString()}</div></>
                                  : s.actual_fee_sat.toLocaleString())
                              : s.quoted_fee_sat != null
                                ? `~${s.quoted_fee_sat.toLocaleString()}`
                                : "—"}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="row-detail">
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
                                        <span className={`badge ${memberSwapBadge(expandedDetail.swap_request.status, expandedDetail.swap_request.failure_reason).cls}`}>
                                          {memberSwapBadge(expandedDetail.swap_request.status, expandedDetail.swap_request.failure_reason).label}
                                        </span>
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Quoted Fee:</span>{" "}
                                        {expandedDetail.swap_request.quoted_fee_sat != null
                                          ? `${expandedDetail.swap_request.quoted_fee_sat.toLocaleString()} sats`
                                          : "—"}
                                      </div>
                                      {expandedDetail.receipt ? (
                                        <div style={{ gridColumn: "1 / -1" }}>
                                          <FeeReceipt receipt={expandedDetail.receipt} usdCents={expandedDetail.swap_request.actual_fee_usd_cents} />
                                        </div>
                                      ) : (
                                        <div>
                                          <span style={{ color: "var(--text-3)" }}>Actual Fee:</span>{" "}
                                          {expandedDetail.swap_request.actual_fee_sat != null
                                            ? `${expandedDetail.swap_request.actual_fee_sat.toLocaleString()} sats`
                                            : "—"}
                                        </div>
                                      )}
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Created:</span>{" "}
                                        {formatDate(expandedDetail.swap_request.created_at)}
                                      </div>
                                      <div>
                                        <span style={{ color: "var(--text-3)" }}>Updated:</span>{" "}
                                        {formatDate(expandedDetail.swap_request.updated_at)}
                                      </div>
                                      {expandedDetail.swap_request.destination_address && (
                                        <div style={{ gridColumn: "1 / -1" }}>
                                          <span style={{ color: "var(--text-3)" }}>Destination:</span>{" "}
                                          <span style={{ fontFamily: "var(--font-id)", fontSize: "0.75rem", wordBreak: "break-all" }}>
                                            {expandedDetail.swap_request.destination_address}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                    {expandedDetail.swap_request.failure_reason && (
                                      <>
                                        <div style={{ color: "var(--red)", fontSize: "0.75rem" }}>
                                          {loopFailureSentence(expandedDetail.swap_request.failure_reason, expandedDetail.swap_request.swap_type === "loop_in" ? "loop_in" : "loop_out")}
                                        </div>
                                        <TechnicalDetails>
                                          <TechRow label="Failure code">{expandedDetail.swap_request.failure_reason}</TechRow>
                                        </TechnicalDetails>
                                      </>
                                    )}
                                    {expandedDetail.execution?.provider_swap_id && (
                                      <div style={{ fontFamily: "var(--font-id)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
                                        Swap hash: {expandedDetail.execution.provider_swap_id}
                                      </div>
                                    )}
                                    {expandedDetail.execution?.onchain_txid && (
                                      <div style={{ fontFamily: "var(--font-id)", fontSize: "0.75rem", color: "var(--text-3)", wordBreak: "break-all" }}>
                                        Bitcoin transaction: {expandedDetail.execution.onchain_txid}
                                      </div>
                                    )}
                                    {!isTerminal(expandedDetail.swap_request.status) && (
                                      <button
                                        className="btn btn-outline"
                                        style={{ alignSelf: "flex-start", fontSize: "0.75rem", padding: "4px 12px" }}
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
