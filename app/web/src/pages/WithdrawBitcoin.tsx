import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtSats, swapExecuteBody, transfersApi, type SwapOptions } from "../api/client";
import { NO_PRICE_LIMIT_SENTENCE, OVER_LIMIT_SENTENCE, reasonText } from "../components/OptionCards";
import { ClockIcon } from "../components/withdraw/ClockIcon";
import { rateNote } from "../api/rate";
import type { ExchangeRate, SwapLimits } from "../api/client";
import type { SwapRequest, SwapQuoteResponse, MemberLiquidityStatusResponse, SwapReceipt } from "../api/client";
import ErrorState from "../components/ErrorState";
import TechnicalDetails, { TechRow } from "../components/TechnicalDetails";
import { capacityTone, capacityRoomWord } from "../components/capacityTone";
import { Amount, usableUsd } from "../components/amount/Amount";
import { NoRateNote } from "../components/amount/NoRateNote";
import { formatUsd } from "../components/amount/amountDescriptor";
import { Choice } from "../components/Choice";
import { AMOUNT_PRESETS, WITHDRAW_COPY as COPY } from "../components/withdraw/withdrawDescriptor";
import { inlineAmount } from "../components/amount/inlineAmount";
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

// The server's word that nothing can move now (GET /api/swaps/options): read,
// never recomputed. nothing_movable covers today's fees leaving less than the
// minimum, which the limits alone don't show.
const BLOCKED_STATES: ReadonlyArray<SwapOptions["state"]> = ["nothing_movable", "daily_limit", "connection_down", "no_hub_channel"];

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
  // Whether the hub channel is up (drive-mode P3): stats fall back to the
  // largest inactive hub channel for display (R18(2)), and the server refuses
  // every Loop Out while it is down, so the page says why rather than blaming
  // the balance. null until stats arrive.
  const [hubActive, setHubActive] = useState<boolean | null>(null);
  // GET /api/swaps/options (drive-mode P3): null until read, or on failure.
  const [options, setOptions] = useState<SwapOptions | null>(null);
  const [optionsDone, setOptionsDone] = useState(false);
  // R5: "Withdraw the most now" over the fee limit waits for this tick (UI
  // only; no request body changes).
  const [allowOnce, setAllowOnce] = useState(false);
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
  // The rate's state, for its note (drive-mode P1 item 3), and every Amount's
  // rate (R6): undefined while it loads (sats only, no sentence), null when the
  // read failed.
  const [rateInfo, setRateInfo] = useState<ExchangeRate | null | undefined>(undefined);
  // U24 H5: tracking-poll freshness — after 3 consecutive failed polls the
  // tracking panel says it can't confirm status instead of spinning silently.
  const [pollFresh, setPollFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [expandedSwapId, setExpandedSwapId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<{ swap_request: SwapRequest; execution: any; events: any[]; receipt?: SwapReceipt | null } | null>(null);

  // ─── Max withdrawable from treasury channel ─────────────────────────
  const [channelLocal, setChannelLocal] = useState<number | null>(null);
  const [channelCapacity, setChannelCapacity] = useState<number | null>(null);
  const [channelLocalPct, setChannelLocalPct] = useState<number | null>(null);
  // V11: the warning is the Liquidity Advisor's state, not a percentage.
  const [advisor, setAdvisor] = useState<MemberLiquidityStatusResponse | null>(null);
  const role = advisor?.channelRole ?? advisor?.classification?.channelRole ?? "unknown";
  const tone = capacityTone(role, advisor?.classification);
  // R1: no fill bar; the advisor's warning word, naming the room (R33 finding
  // 7), is one line under the big amount, only when it applies.
  const toneWord = capacityRoomWord(role, tone);

  // The default amount the page set, and whether the over-limit check has run
  // on it once (R5 edge, Ethan's "recs" 2026-11-17).
  const defaultAmountRef = useRef<number | null>(null);
  const defaultCheckedRef = useRef(false);

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
        setAmount((a) => {
          const next = min == null || now == null || now < min ? 0 : a >= min && a <= now ? a : min;
          defaultAmountRef.current = next;
          return next;
        });
      })
      .catch(() => {});
    loadAdvisor();
    // Drive-mode P3: the option cards and the quote-based Max (read-only).
    transfersApi.getSwapOptions("loop_out")
      .then(setOptions)
      .catch(() => setOptions(null))
      .finally(() => setOptionsDone(true));
  }, []);

  // Below the minimum (R7): the limits say less than the minimum is free now,
  // or the server's options say nothing can move (its nothing_movable, daily
  // limit, connection down or no connection). Gated on options.state, so
  // today's fees leaving less than the minimum is no longer missed.
  const limitsKnown = minW != null && availableNow != null;
  const blocked = (limitsKnown && availableNow! < minW!) || (options != null && BLOCKED_STATES.includes(options.state));
  const canWithdraw = limitsKnown && !blocked;

  // "You can withdraw up to" (drive-mode P3, R25): the QUOTE-BASED maximum —
  // available_now less today's quoted fee, re-quoted, so a Loop Out of exactly
  // it passes execute's amount + fee ≤ room check. While the quote is out the
  // page says it is checking; if loopd can't quote, it falls back to
  // available_now with R25's original sentence.
  const nowCard = options?.state === "ok" ? options.cards.find((c) => c.key === "now") ?? null : null;
  const quoteBased = options?.quote_state === "ok" && nowCard?.amount_sats != null;
  const maxWithdrawable = !canWithdraw ? null : quoteBased ? nowCard!.amount_sats! : optionsDone ? availableNow : null;
  const checkingFees = canWithdraw && !optionsDone;
  // R5: the most, over the fee limit, is set only through "Withdraw the most
  // now" after its tick — so no preset may reach it (the Max button that
  // bypassed the tick is gone).
  const overLimit = nowCard?.over_fee_limit === true && maxWithdrawable != null;
  // Even the minimum is over the fee limit: the over-limit most is the minimum.
  // The box starts empty (below) and, ruled 2026-11-18, shows no placeholder.
  const minOverLimit = overLimit && minW != null && maxWithdrawable! <= minW;
  // Presets the policy would accept now (D1.9); none when nothing can be withdrawn.
  const presets = canWithdraw
    ? AMOUNT_PRESETS.filter((p) => p >= minW! && p <= (maxWithdrawable ?? availableNow!) && !(overLimit && p >= maxWithdrawable!))
    : [];
  // R2/R3: the server's one recommendation. Waiting → the tip; now → no tip.
  const recommended = options?.state === "ok" ? options.cards.find((c) => c.recommended) ?? null : null;
  const waitCard = options?.state === "ok" ? options.cards.find((c) => c.key !== "now") ?? null : null;
  const waitRecommended = recommended != null && recommended.key !== "now" && options?.reason != null;

  // R5's edge (Ethan's "recs", 2026-11-17): when even the minimum is over the
  // fee limit — the over-limit most is at or below the default amount — the box
  // starts EMPTY, so the only path to an over-limit amount is "Withdraw the most
  // now" with its tick. Runs once, when both the default and the options are
  // in, and only on the page's own default (an amount the member chose stays).
  useEffect(() => {
    if (defaultCheckedRef.current || defaultAmountRef.current == null || !optionsDone) return;
    defaultCheckedRef.current = true;
    const most = overLimit ? maxWithdrawable : null;
    const dflt = defaultAmountRef.current;
    if (most != null && dflt > 0 && dflt >= most) setAmount((a) => (a === dflt ? 0 : a));
  }, [limits, optionsDone, overLimit, maxWithdrawable]);

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
    api.getExchangeRate().then((r) => { setRateInfo(r); setUsdRate(r.usd); }).catch(() => setRateInfo(null));
  }, []);
  const usd = usableUsd(rateInfo);

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

  // The page's header (R6): the title and lead; "Price as of …" by the lead
  // when the rate is stale; and the page's ONE no-price sentence (NoRateNote:
  // never while the rate loads).
  const header = (
    <div style={{ marginBottom: 24 }}>
      <h1 style={{ marginBottom: 4 }}>{COPY.title}</h1>
      <p className="text-dim" style={{ fontSize: "0.875rem" }}>{COPY.lead}</p>
      {rateInfo?.state !== "none" && rateNote(rateInfo) && (
        <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{rateNote(rateInfo)}</p>
      )}
      <NoRateNote rate={rateInfo} />
    </div>
  );

  if (stage === "loading") {
    return (
      <div>
        {header}
        <div className="loading-shimmer" style={{ height: 200, borderRadius: 8 }} />
      </div>
    );
  }

  // R7's sentence, the binding cause first: the connection is down (the server
  // refuses every Loop Out), today's limit is used, or too little is waiting —
  // with the SERVER's trigger and minimum, never recomputed here. Until the
  // options arrive, only the first two can be said.
  const dailyLeft = limits?.loop_out?.daily_remaining_sats ?? null;
  const minShown = options?.min_sats ?? minW;
  const blockedSentence = !blocked ? null
    : hubActive === false || options?.state === "connection_down" ? COPY.connectionDown
    : options?.state === "daily_limit" || (dailyLeft != null && minW != null && dailyLeft < minW) ? COPY.dailyLimit
    : !optionsDone || minShown == null ? null
    : options?.trigger_sats != null ? COPY.trigger(inlineAmount(options.trigger_sats, usd, true), inlineAmount(minShown, usd))
    : COPY.leastOnly(inlineAmount(minShown, usd));
  const formStage = stage === "form" || stage === "quoting";

  return (
    <div>
      {header}

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

      {/* ─── The form: what is always visible ─────────────────────────── */}
      {formStage && (
        <div className="panel fade-in">
          <div className="panel-body withdraw-form">
            {/* The one answer: the most that can move now, or, below the
                minimum, that nothing can (R7). */}
            <section className="withdraw-answer">
              {blocked ? (
                <div className="withdraw-answer-big" data-testid="withdraw-answer">{COPY.nothingYet}</div>
              ) : (
                <>
                  <div className="withdraw-answer-label">{COPY.upTo}</div>
                  <div data-testid="withdraw-answer">
                    <Amount sats={maxWithdrawable} rate={rateInfo} size="hero" />
                  </div>
                  {checkingFees && <div className="withdraw-answer-sub">{COPY.checkingFees}</div>}
                </>
              )}
              {channelLocal != null && (
                <div className="withdraw-answer-sub" data-testid="in-connection">
                  {COPY.inConnection(inlineAmount(channelLocal, usd))}
                </div>
              )}
              {toneWord && <div className="withdraw-warning" data-testid="capacity-warning">{toneWord}</div>}
              {blockedSentence && (
                <p className="withdraw-answer-why" data-testid="withdraw-nothing-movable">{blockedSentence}</p>
              )}
            </section>

            {/* R2/R3: the tip, whenever the server recommends waiting. Ruled
                2026-11-18: one plain line with the clock icon, no box, and the
                server's bigger amount. Its reason and the wait card's two
                sentences are in "Why not all of it?". */}
            {waitRecommended && (
              <p className="withdraw-tip" data-testid="withdraw-tip">
                <ClockIcon />
                <span>
                  {waitCard?.amount_sats != null
                    ? COPY.tip(inlineAmount(waitCard.amount_sats, usd, true))
                    : COPY.tipNoAmount}
                </span>
              </p>
            )}

            {/* How much: presets (dollars over sats), the box (sats, dollars
                under), and one note line. Hidden below the minimum (R7). */}
            {canWithdraw && (
              <section className="withdraw-how">
                <div className="form-label" id="withdraw-how-much">{COPY.howMuch}</div>
                {presets.length > 0 && (
                  <div className="withdraw-presets">
                    <Choice
                      name="withdraw-preset"
                      labelledBy="withdraw-how-much"
                      value={presets.includes(amount) ? String(amount) : null}
                      onChange={(v) => setAmount(Number(v))}
                      options={presets.map((p) => ({ value: String(p), label: <Amount sats={p} rate={rateInfo} /> }))}
                    />
                  </div>
                )}
                <div className="withdraw-box">
                  <div className="withdraw-input">
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
                      placeholder={minOverLimit ? undefined : "250,000"}
                    />
                    <span className="withdraw-unit">{COPY.satsUnit}</span>
                  </div>
                  {usd != null && amount > 0 && <div className="withdraw-box-usd">{formatUsd(amount, usd).text}</div>}
                </div>
                {/* R1: the percentages, a share of the connection. Ruled
                    2026-11-18: none while the box is empty, in any state. */}
                {amount > 0 && channelLocal != null && channelCapacity != null && channelCapacity > 0 && channelLocalPct != null && (
                  <p className="withdraw-note" data-testid="capacity-text">
                    {COPY.note(channelLocalPct, Math.max(0, Math.round(((channelLocal - amount) / channelCapacity) * 100)))}
                  </p>
                )}
                {amount > availableNow! && <div className="withdraw-error">{COPY.overAvailable(availableNow!)}</div>}
                {amount > 0 && amount < minW! && <div className="withdraw-error">{COPY.underMinimum(minW!)}</div>}
              </section>
            )}

            <div className="withdraw-goes">
              <span className="text-dim">{COPY.goesTo}</span> {COPY.goesToWhere}
            </div>

            {/* The one action. Hidden below the minimum (R7). */}
            {!blocked && (
              <div className="withdraw-act">
                {!addressLoading && !address && (
                  <div className="withdraw-error" data-testid="address-failed">
                    {COPY.addressFailed}{" "}
                    <button className="btn btn-ghost" style={{ fontSize: "inherit", padding: 0 }} onClick={generateAddress}>
                      {COPY.retry}
                    </button>
                  </div>
                )}
                {error && <div className="withdraw-error">{error}</div>}
                <button
                  className="btn btn-primary"
                  style={{ width: "100%" }}
                  onClick={handleGetQuote}
                  disabled={stage === "quoting" || addressLoading || !address || !canWithdraw || amount < minW! || amount > availableNow!}
                >
                  {stage === "quoting" ? COPY.reviewing : COPY.review}
                </button>
                <p className="withdraw-review-line">{COPY.reviewLine}</p>
              </div>
            )}
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

      {/* ─── The closed rows: one tap away ─────────────────────────────── */}
      {/* The first three are the form's; "Recent withdrawals" is on every
          stage. Each is closed until the member opens it. */}
      <div className="withdraw-rows">
        {/* drive-mode P2 item 16 (R11(4)): what always stays, Withdraw only.
            "Why not all of it?" (R27(7)). The figures are the server's (GET
            /api/swaps/limits loop_out.always_stays); its parts sum to its
            total. Text unchanged. */}
        {/* Ruled 2026-11-18: the wait's reason and the wait card's two
            sentences moved here from the tip, so the row shows whenever they
            apply, with or without what always stays. */}
        {formStage && (limits?.loop_out?.always_stays || waitRecommended) && (() => {
          const a = limits?.loop_out?.always_stays ?? null;
          const rows: Array<[string, number]> = a ? [
            ["Always stays to keep you connected", a.total_sats],
            ["Connection reserve", a.reserve_sats],
            ["Lightning fee headroom", a.fee_headroom_sats],
            ["Swap buffer", a.swap_buffer_sats],
          ] : [];
          return (
            <details className="withdraw-row" data-testid="row-why-not">
              <summary>{COPY.rowWhyNot}</summary>
              <div className="withdraw-row-body">
                {waitRecommended && (
                  <div className="withdraw-why-wait" data-testid="why-wait">
                    <div data-testid="recommended-reason">{reasonText(options!.reason!, true)}</div>
                    {waitCard?.key === "wait_bigger" && options!.floor_sats != null && (
                      <div>{COPY.tipWorthMore(inlineAmount(options!.floor_sats, usd))}</div>
                    )}
                    {waitCard?.amount_sats != null && (
                      <div>{COPY.tipLater(inlineAmount(waitCard.amount_sats, usd, true))}</div>
                    )}
                  </div>
                )}
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

        {/* "Withdraw the most now": the "now" card's facts (drive-mode P3), and
            R25's sentence (R4). It only pre-fills the amount; the member still
            reviews and confirms. Over the fee limit, its button waits for the
            tick (R5). */}
        {formStage && canWithdraw && maxWithdrawable != null && (
          <details className="withdraw-row" data-testid="row-most-now">
            <summary>{COPY.rowMostNow}</summary>
            <div className="withdraw-row-body">
              <div className="withdraw-most-figures">
                <span><span className="text-dim">{COPY.mostAmount} </span><Amount sats={maxWithdrawable} rate={rateInfo} /></span>
                {nowCard?.fee_sats != null && (
                  <span><span className="text-dim">{COPY.mostFee} </span><Amount sats={nowCard.fee_sats} rate={rateInfo} /></span>
                )}
              </div>
              {nowCard && options?.room_sats != null && (
                <div>{COPY.mostRises(inlineAmount(options.room_sats + maxWithdrawable, usd))}</div>
              )}
              {overLimit && <div data-testid="over-limit">{OVER_LIMIT_SENTENCE}</div>}
              {options?.fee_limit_checked === false && nowCard?.fee_sats != null && (
                <div data-testid="limit-unchecked">{NO_PRICE_LIMIT_SENTENCE}</div>
              )}
              {recommended?.key === "now" && options?.reason && (
                <div data-testid="recommended-reason">{reasonText(options.reason, true)}</div>
              )}
              <div data-testid="max-fee-note">{quoteBased ? COPY.maxFeeQuoted : COPY.maxFeeUnquoted}</div>
              {overLimit && (
                <label className="withdraw-allow">
                  <input type="checkbox" checked={allowOnce} onChange={(e) => setAllowOnce(e.target.checked)} />
                  {COPY.allowOnce}
                </label>
              )}
              <div>
                <button className="btn btn-outline" disabled={overLimit && !allowOnce} onClick={() => setAmount(maxWithdrawable)}>
                  {COPY.useTheMost}
                </button>
              </div>
            </div>
          </details>
        )}

        {/* "Limits and address": the effective min and max (drive-mode P1 item
            6), and the node's own address, generated on load. */}
        {formStage && (
          <details className="withdraw-row" data-testid="row-limits">
            <summary>{COPY.rowLimits}</summary>
            <div className="withdraw-row-body">
              {minW != null && maxW != null && <div>{COPY.limits(minW, maxW)}</div>}
              {addressLoading ? (
                <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
              ) : address ? (
                <div className="withdraw-address">
                  <div className="withdraw-address-text">{address}</div>
                  <button className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={handleCopy}>
                    {copied ? COPY.copied : COPY.copy}
                  </button>
                  <button className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={handleNewAddress}>
                    {COPY.newAddress}
                  </button>
                </div>
              ) : null}
              <div className="text-dim">{COPY.addressWhere}</div>
            </div>
          </details>
        )}

        <details className="withdraw-row" data-testid="row-history">
          <summary>{COPY.rowHistory(historyLoading || (historyError !== null && history.length === 0) ? null : history.length)}</summary>
          <div className="withdraw-row-body">
          {historyLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
              ))}
            </div>
          ) : historyError !== null && history.length === 0 ? (
            <ErrorState
              bare
              message={COPY.historyFailed}
              detail={historyError}
              onRetry={loadHistory}
            />
          ) : history.length === 0 ? (
            <div className="empty-state">{COPY.historyEmpty}</div>
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
        </details>
      </div>
    </div>
  );
}
