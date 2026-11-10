// "I have BTC" payment-path modal (decision 2026-06-11 §2).
//
// Two paths from a chooser:
//   • Pay from this node (primary) — preview amount/destination/fee, one
//     "Confirm send" → POST /api/subscription/pay-from-node, txid on
//     success. Matches the WithdrawBitcoin quote→confirm precedent: one
//     explicit confirm for an ordinary send. The server may refuse a send
//     it cannot make as shown (decisions/2026-11-05-pay-from-node-…, D1–D3),
//     and each refusal the member can resolve is a further step: an earlier
//     payment not yet credited (repeat_ack), a price above the one last
//     acknowledged (price_ack), or details that changed (back to confirm).
//   • I have BTC elsewhere (secondary) — BIP-21 anchor handoff.
//
// The POST ECHOES the price and address this modal rendered — `target`,
// from the prop until a refusal says they changed, then from a fresh quote
// — and the server compares them with its own and sends only its own.
//
// Amounts are dollars first with the sats beside them (drive-mode R2). The
// modal fetches the BTC/USD rate itself; when there is none it shows sats
// and says why (rate.ts).
//
// Rendered through a portal to document.body (G3 ruling R1, 2026-11-06): at
// the Settings mount the modal sat inside SubscriptionPanel's card, which made
// the card the overlay's containing block, so the overlay dimmed only the
// content column and the dialog sat low, its buttons cut off at 1440×900.
// Out of every card, the fixed overlay is the viewport at every mount site
// (the same mechanism and fix as ActionConfirmModal, ruling ll).
//
// State lives in the pure reducer (payModalMachine.ts); this component
// renders each step and drives the side effects (rate and fee quote fetch,
// the POST, clipboard). The panel's existing 15s status poll performs the
// prepay→current (or lapsed→current) transition — the send is an
// ordinary on-chain payment as far as the detector is concerned, so no
// bespoke pending-poll here.

import { useEffect, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { formatDistanceToNow } from "date-fns";
import {
  api,
  type ExchangeRate,
  type SubscriptionStatusApplicable,
  type PayFromNodeBody,
  type PayFromNodeQuote,
} from "../api/client";
import { rateNote, RATE_NONE_SENTENCE } from "../api/rate";
import { bip21Uri } from "./bip21";
import { classifyConfirmError } from "./actionConfirm/confirmErrors";
import {
  INITIAL_PAY_MODAL_STATE,
  acksOf,
  reducePayModal,
  type PayModalAcks,
} from "./payModalMachine";
import { renewalAmount } from "./subscriptionBanner";
import { payErrorMessage } from "./subscriptionPayMessages";
import { depositAddressDisplay, trustCopy, trustStateOfRefusal, type TrustState } from "./paymentTrust";

// This modal's wording for a missing confirmation (G3 ruling R8).
const CONFIRMATION_REQUIRED_MESSAGE = "Not confirmed. Nothing was sent. Close this window and try again.";

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
  // treasury-price-trust C15: the proxy's labels ride along, so the modal can
  // refuse to render the address (or its BIP-21 URI) from a status that is not
  // verified and pinned, whichever surface opened it.
  status: Pick<
    SubscriptionStatusApplicable,
    "price_sats" | "deposit_address" | "treasury_signature" | "treasury_signature_reason" | "treasury_pay_refusal"
  >;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(reducePayModal, INITIAL_PAY_MODAL_STATE);
  const [quote, setQuote] = useState<PayFromNodeQuote | null>(null);
  const [quoteError, setQuoteError] = useState(false);
  // treasury-price-trust (spec §4 R8): a quote refused because the status is
  // not verified, or names a target this node won't pay. The state shows and
  // no confirm is offered.
  const [quoteRefusal, setQuoteRefusal] = useState<TrustState | null>(null);
  const [copied, setCopied] = useState(false);
  // What is rendered, and therefore what is echoed.
  const [target, setTarget] = useState({
    price_sats: status.price_sats,
    deposit_address: status.deposit_address,
  });
  // The BTC/USD rate, fetched here. A failed fetch is the rate-none state.
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [rateFailed, setRateFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getExchangeRate()
      .then((r) => { if (!cancelled) setRate(r); })
      .catch(() => { if (!cancelled) setRateFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const usdRate = rate && rate.state !== "none" ? rate.usd : null;
  // An amount renders as one unbreakable unit, so "$X.XX (N sats)" never
  // wraps inside itself on a phone (G3 ruling R2; .sub-amount in styles.css).
  const amount = (sats: number, prefix = "") => (
    <span className="sub-amount">{prefix}{renewalAmount(sats, usdRate).text}</span>
  );
  // A past amount (a payment already sent, a price already agreed) in sats
  // only: today's rate would misstate what it was (G3 ruling R7).
  const satsOnly = (sats: number) => (
    <span className="sub-amount">{renewalAmount(sats, null).text}</span>
  );
  const note = rateFailed ? RATE_NONE_SENTENCE : rateNote(rate);
  // The rate's note on every step that shows an amount (G3 ruling R7). A step
  // whose amounts are all past, in sats only, takes only the no-rate sentence:
  // "Price as of …" beside no dollar figure would date nothing.
  const rateLine = (showsDollars: boolean) => {
    const line = showsDollars || note === RATE_NONE_SENTENCE ? note : null;
    return line ? <p className="sub-fineprint" style={{ marginTop: 10 }}>{line}</p> : null;
  };

  // Fetch the fee estimate when the preview (confirm step) opens. The
  // send itself doesn't need the quote — LND attaches its own fee at
  // broadcast — so a failed quote degrades to "estimate unavailable"
  // without blocking Confirm.
  useEffect(() => {
    if (state.step !== "confirm") return;
    let cancelled = false;
    setQuote(null);
    setQuoteError(false);
    setQuoteRefusal(null);
    api
      .getPayFromNodeQuote()
      .then((q) => { if (!cancelled) setQuote(q); })
      .catch((e: any) => {
        if (cancelled) return;
        const refusal = trustStateOfRefusal(e?.code, e?.body);
        if (refusal) setQuoteRefusal(refusal);
        else setQuoteError(true);
      });
    return () => { cancelled = true; };
  }, [state.step]);

  // One send, carrying the echo and the acknowledgements given so far in this
  // session. Each refusal the member can resolve becomes a step.
  async function send(acks: PayModalAcks) {
    const body: PayFromNodeBody = {
      amount_sats: target.price_sats,
      deposit_address: target.deposit_address,
      ...(acks.repeat ? { repeat_acknowledged: true as const } : {}),
      ...(acks.price ? { price_acknowledged: true as const } : {}),
    };
    try {
      const { txid } = await api.payFromNode(body);
      dispatch({ t: "success", txid });
    } catch (e: any) {
      // A confirmation refusal (400 required / 409 mismatch) renders through
      // the shared classifier, so a 409 reads as the bug it is, never as
      // "try again" (actionConfirm/confirmErrors.ts).
      //
      // Two overrides in this modal only (G3 ruling R8; confirmErrors.ts's
      // shared copy is unchanged): "required" tells the member to close and
      // retry, since this modal has no fields to fill in, and "mismatch"
      // offers no Try again, because repeating it fails the same way.
      const confirmView = classifyConfirmError(e);
      if (confirmView) {
        const message =
          confirmView.kind === "required"
            ? CONFIRMATION_REQUIRED_MESSAGE
            : `${confirmView.title}. ${confirmView.detail}`;
        const code = confirmView.kind === "mismatch" ? "confirmation_mismatch" : "confirmation_required";
        dispatch({ t: "error", message, code });
        return;
      }
      const b = e?.body ?? {};
      if (e?.code === "repeat_unacknowledged" && b.marker) {
        dispatch({ t: "refused_repeat", marker: b.marker });
      } else if (e?.code === "price_above_acknowledged" && typeof b.price_sats === "number") {
        dispatch({
          t: "refused_price",
          previousPrice: typeof b.acknowledged_price_sats === "number" ? b.acknowledged_price_sats : null,
          newPrice: b.price_sats,
        });
      } else if (e?.code === "pay_target_changed") {
        try {
          const q = await api.getPayFromNodeQuote();
          setTarget({ price_sats: q.amount_sats, deposit_address: q.deposit_address });
          dispatch({ t: "target_changed" });
        } catch {
          dispatch({ t: "error", message: payErrorMessage("pay_target_changed"), code: "pay_target_changed" });
        }
      } else {
        dispatch({ t: "error", message: payErrorMessage(e?.code, e?.detail, e?.body), code: e?.code });
      }
    }
  }

  function handleConfirm() {
    const acks = acksOf(state);
    dispatch({ t: "confirm" }); // → sending (also disables the button)
    void send(acks);
  }

  function handleAckRepeat() {
    const acks = { ...acksOf(state), repeat: true };
    dispatch({ t: "ack_repeat" }); // → sending, repeat acknowledged
    void send(acks);
  }

  function handleAckPrice() {
    const acks = { ...acksOf(state), price: true };
    dispatch({ t: "ack_price" }); // → sending, price acknowledged
    void send(acks);
  }

  function handleCopyTxid(txid: string) {
    copyText(txid);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  // treasury-price-trust C15: a status not verified and pinned shows its
  // S-state and a Close button — no chooser, no address, no BIP-21 URI.
  const display = depositAddressDisplay({ ...status, applicable: true });
  if (!display.show) {
    const s = display.state;
    const copy = s
      ? trustCopy(s, s.state === "S4_price_above_cap" ? renewalAmount(s.price_sats, usdRate).text : undefined)
      : null;
    return createPortal(
      <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="Pay subscription">
        <div className="dialog-card sub-pay-modal">
          {copy && (
            <div className="sub-alert sub-alert-amber" role="alert" data-trust-state={s!.state}>
              <span className="sub-alert-icon" aria-hidden>!</span>
              <div className="sub-alert-body">
                <strong>{copy.headline}</strong>
                {copy.body ? <> {copy.body}</> : null}
              </div>
            </div>
          )}
          <div className="dialog-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-outline" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="Pay subscription">
      <div className="dialog-card sub-pay-modal">
        {/* ── Chooser ── */}
        {state.step === "chooser" && (
          <>
            <div className="dialog-title">Where is your BTC?</div>
            <div className="dialog-body">
              Pay {amount(target.price_sats)} to your subscription deposit address.
            </div>
            {rateLine(true)}
            {/* The note has no bottom margin; space it from the buttons (r2 capture, m06). */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: note ? 16 : 0 }}>
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
            {state.step === "confirm" && state.detailsChanged && (
              // An amber warning, not a red danger notice: nothing failed, the
              // member only has to check again (G3 ruling R10).
              <div className="sub-alert sub-alert-amber" style={{ marginBottom: 14 }}>
                <span className="sub-alert-icon" aria-hidden>!</span>
                <div className="sub-alert-body">
                  <strong>The payment details changed.</strong> The amount or the address
                  changed after you opened this window. Check the new details below, then
                  confirm again.
                </div>
              </div>
            )}
            {quoteRefusal && (() => {
              const copy = trustCopy(
                quoteRefusal,
                quoteRefusal.state === "S4_price_above_cap"
                  ? renewalAmount(quoteRefusal.price_sats, usdRate).text
                  : undefined,
              );
              return (
                <div className="sub-alert sub-alert-amber" role="alert" data-trust-state={quoteRefusal.state} style={{ marginBottom: 14 }}>
                  <span className="sub-alert-icon" aria-hidden>!</span>
                  <div className="sub-alert-body">
                    <strong>{copy.headline}</strong>
                    {copy.body ? <> {copy.body}</> : null}
                  </div>
                </div>
              );
            })()}
            <div className="dialog-body" style={{ marginBottom: 14 }}>
              Sends an on-chain payment from your node's wallet to your own
              subscription deposit address.
            </div>
            <dl className="sub-pay-preview">
              <div>
                <dt>Amount</dt>
                <dd>{amount(target.price_sats)}</dd>
              </div>
              <div>
                <dt>To deposit address</dt>
                {/* C15: no address while the quote refuses it. */}
                <dd className="sub-pay-address" title={quoteRefusal ? undefined : target.deposit_address}>
                  {quoteRefusal ? "—" : truncMiddle(target.deposit_address)}
                </dd>
              </div>
              <div>
                <dt>Estimated network fee</dt>
                <dd>
                  {quote
                    ? amount(quote.estimated_fee_sats, "~")
                    : quoteError
                      ? "estimate unavailable"
                      : "estimating…"}
                </dd>
              </div>
            </dl>
            {rateLine(true)}
            <p className="sub-fineprint" style={{ marginTop: 10 }}>
              The exact network fee is set when it sends — targeting confirmation within
              about an hour. Payment is detected within ~15–30 seconds after the first
              confirmation.
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
                disabled={state.step === "sending" || quoteRefusal != null}
              >
                {state.step === "sending" ? "Sending…" : "Confirm send"}
              </button>
            </div>
          </>
        )}

        {/* ── An earlier payment is not yet credited (D2). Copy approved at
             G3, 2026-11-06 (ruling R6). ── */}
        {state.step === "repeat_ack" && (
          <>
            <div className="dialog-title">You already sent a payment</div>
            <div className="dialog-body">
              Your node sent {satsOnly(state.marker.amount_sats)} to your subscription address{" "}
              {formatDistanceToNow(new Date(state.marker.created_at * 1000), { addSuffix: true })}
              {state.marker.txid ? ` (transaction ${truncMiddle(state.marker.txid, 8, 8)})` : ""}.
              It hasn't been credited yet. Most payments are credited soon after their
              first confirmation.
            </div>
            <div className="dialog-body">
              If you send again now, you pay twice. The extra payment is not lost: it
              extends your paid-through date.
            </div>
            {rateLine(false)}
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button className="btn btn-outline" onClick={handleAckRepeat}>
                Send another payment
              </button>
              <button className="btn btn-primary" onClick={onClose}>Not now</button>
            </div>
          </>
        )}

        {/* ── The price is above the one last acknowledged (D3). Copy approved
             at G3, 2026-11-06 (ruling R7). ── */}
        {state.step === "price_ack" && (
          <>
            <div className="dialog-title">The subscription price went up</div>
            <div className="dialog-body">
              The price is now {amount(state.newPrice)}
              {state.previousPrice != null ? <>, up from {satsOnly(state.previousPrice)}</> : null}.
              Nothing is sent until you accept the new price.
            </div>
            {rateLine(true)}
            <div className="dialog-actions" style={{ marginTop: 18 }}>
              <button className="btn btn-outline" onClick={onClose}>Not now</button>
              <button className="btn btn-primary" onClick={handleAckPrice}>
                Accept {amount(state.newPrice)}
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
              {/* A mismatch is a bug: repeating it fails the same way (R8). */}
              {state.code !== "confirmation_mismatch" && (
                <button className="btn btn-primary" onClick={() => dispatch({ t: "back" })}>
                  Try again
                </button>
              )}
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
              href={bip21Uri(target.deposit_address, target.price_sats)}
            >
              Open in wallet ({amount(target.price_sats)})
            </a>
            {rateLine(true)}
            <p className="sub-fineprint" style={{ marginTop: 10 }}>
              No Bitcoin wallet registered for <code className="ident">bitcoin:</code> links? This
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
    </div>,
    document.body,
  );
}
