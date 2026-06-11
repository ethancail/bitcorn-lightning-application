// "I have BTC" payment-path modal (decision 2026-06-11 §2).
//
// Two paths from a chooser:
//   • Pay from this node (primary) — preview amount/destination/fee, one
//     "Confirm send" → POST /api/subscription/pay-from-node, txid on
//     success. Matches the WithdrawBitcoin quote→confirm precedent (one
//     explicit confirm, no double-confirm).
//   • I have BTC elsewhere (secondary) — BIP-21 anchor handoff.
//
// State lives in the pure reducer (payModalMachine.ts); this component
// renders each step and drives the side effects (fee quote fetch, the
// POST, clipboard). The panel's existing 15s status poll performs the
// prepay→current (or lapsed→current) transition — the send is an
// ordinary on-chain payment as far as the detector is concerned, so no
// bespoke pending-poll here.

import { useEffect, useReducer, useState } from "react";
import {
  api,
  fmtSats,
  type SubscriptionStatusApplicable,
  type PayFromNodeQuote,
} from "../api/client";
import { bip21Uri } from "./bip21";
import {
  INITIAL_PAY_MODAL_STATE,
  reducePayModal,
} from "./payModalMachine";
import { payErrorMessage } from "./subscriptionPayMessages";

function truncMiddle(s: string, head = 12, tail = 8): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Clipboard with the document.execCommand fallback — navigator.clipboard
// fails silently on plain HTTP (Tailscale IPs), see CLAUDE.md.
function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
  } catch {
    fallback();
  }
}

export default function PayFromNodeModal({
  status,
  onClose,
}: {
  // Only price_sats + deposit_address are read, so the prop is narrowed
  // to that Pick. The panel's full-status call site still satisfies it,
  // and the 402 RoutingDeniedNotice can feed the denial payload directly
  // without a second status fetch.
  status: Pick<SubscriptionStatusApplicable, "price_sats" | "deposit_address">;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(reducePayModal, INITIAL_PAY_MODAL_STATE);
  const [quote, setQuote] = useState<PayFromNodeQuote | null>(null);
  const [quoteError, setQuoteError] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch the fee estimate when the preview (confirm step) opens. The
  // send itself doesn't need the quote — LND attaches its own fee at
  // broadcast — so a failed quote degrades to "estimate unavailable"
  // without blocking Confirm.
  useEffect(() => {
    if (state.step !== "confirm") return;
    let cancelled = false;
    setQuote(null);
    setQuoteError(false);
    api
      .getPayFromNodeQuote()
      .then((q) => { if (!cancelled) setQuote(q); })
      .catch(() => { if (!cancelled) setQuoteError(true); });
    return () => { cancelled = true; };
  }, [state.step]);

  async function handleConfirm() {
    dispatch({ t: "confirm" }); // → sending (also disables the button)
    try {
      const { txid } = await api.payFromNode();
      dispatch({ t: "success", txid });
    } catch (e: any) {
      dispatch({ t: "error", message: payErrorMessage(e?.code, e?.detail), code: e?.code });
    }
  }

  function handleCopyTxid(txid: string) {
    copyText(txid);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="Pay subscription">
      <div className="dialog-card sub-pay-modal">
        {/* ── Chooser ── */}
        {state.step === "chooser" && (
          <>
            <div className="dialog-title">Where is your BTC?</div>
            <div className="dialog-body">
              Pay {fmtSats(status.price_sats)} to your subscription deposit address.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={() => dispatch({ t: "choose", path: "this-node" })}
              >
                Pay from this node
              </button>
              <button
                className="btn btn-outline"
                style={{ width: "100%" }}
                onClick={() => dispatch({ t: "choose", path: "elsewhere" })}
              >
                I have BTC elsewhere
              </button>
            </div>
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button className="btn btn-outline" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {/* ── Pay from this node: preview + confirm ── */}
        {(state.step === "confirm" || state.step === "sending") && (
          <>
            <div className="dialog-title">Pay from this node</div>
            <div className="dialog-body" style={{ marginBottom: 14 }}>
              Sends an on-chain payment from your node's wallet to your own
              subscription deposit address.
            </div>
            <dl className="sub-pay-preview">
              <div>
                <dt>Amount</dt>
                <dd>{fmtSats(status.price_sats)}</dd>
              </div>
              <div>
                <dt>To deposit address</dt>
                <dd title={status.deposit_address}>{truncMiddle(status.deposit_address)}</dd>
              </div>
              <div>
                <dt>Estimated network fee</dt>
                <dd>
                  {quote
                    ? `~${fmtSats(quote.estimated_fee_sats)}`
                    : quoteError
                      ? "estimate unavailable"
                      : "estimating…"}
                </dd>
              </div>
            </dl>
            <p className="sub-fineprint" style={{ marginTop: 10 }}>
              The exact fee is set by your node at a 6-block target. Payment is
              detected within ~15–30 seconds after the first confirmation.
            </p>
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button
                className="btn btn-outline"
                onClick={() => dispatch({ t: "back" })}
                disabled={state.step === "sending"}
              >
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={state.step === "sending"}
              >
                {state.step === "sending" ? "Sending…" : "Confirm send"}
              </button>
            </div>
          </>
        )}

        {/* ── Success ── */}
        {state.step === "success" && (
          <>
            <div className="dialog-title">Payment sent</div>
            <div className="dialog-body">
              Your payment is broadcasting. It's detected within ~15–30 seconds
              after the first confirmation — your subscription status updates
              automatically.
            </div>
            <div className="sub-stat-label">TRANSACTION ID</div>
            <code className="sub-deposit-address" title={state.txid}>
              {truncMiddle(state.txid, 16, 12)}
            </code>
            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-outline" onClick={() => handleCopyTxid(state.txid)}>
                {copied ? "✓ Copied" : "Copy txid"}
              </button>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {/* ── Error ── */}
        {state.step === "error" && (
          <>
            <div className="dialog-title">Payment failed</div>
            <div className="sub-alert sub-alert-dim-red" style={{ marginBottom: 16 }}>
              <span className="sub-alert-icon" aria-hidden>✕</span>
              <div className="sub-alert-body">{state.message}</div>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={() => dispatch({ t: "back" })}>
                Try again
              </button>
            </div>
          </>
        )}

        {/* ── I have BTC elsewhere: BIP-21 handoff ── */}
        {state.step === "bip21" && (
          <>
            <div className="dialog-title">I have BTC elsewhere</div>
            <div className="dialog-body">
              Open your Bitcoin wallet with the deposit address and amount
              pre-filled, or copy the address from the deposit block in the
              panel.
            </div>
            {/* Anchor uses the lowercase bip21Uri() output directly — NOT the
                QR string (which is uppercased and would break wallet parsers).
                No window.open: bitcoin: URIs are protocol handoffs, not pages;
                with no registered handler the click is a harmless no-op. */}
            <a
              className="btn btn-primary"
              style={{ width: "100%", textAlign: "center", display: "block" }}
              href={bip21Uri(status.deposit_address, status.price_sats)}
            >
              Open in wallet ({fmtSats(status.price_sats)})
            </a>
            <p className="sub-fineprint" style={{ marginTop: 10 }}>
              No Bitcoin wallet registered for <code>bitcoin:</code> links? This
              button does nothing — use the deposit address and QR code in the
              panel instead.
            </p>
            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-outline" onClick={() => dispatch({ t: "back" })}>Back</button>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
