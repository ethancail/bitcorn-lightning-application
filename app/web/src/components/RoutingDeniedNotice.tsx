// Point-of-block remediation notice (Direction D).
//
// Source of truth: specs/2026-06-11-subscription-discoverability-implementation.md §4
//
// Rendered in place of a form's generic error string when a gated action
// (send / receive) is refused with the structured HTTP 402
// subscription_routing_denied response. Explains which action is blocked,
// the member's standing, the amount, and offers the same inline
// PayFromNodeModal as the dashboard banner — the member never navigates
// away. Severity derives from payload.tier through the SAME shared map the
// banner uses (bannerSeverityForTierName), so the two surfaces can't drift.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtSats, truncPubkey, type SubscriptionStatus } from "../api/client";
import type { RoutingDeniedPayload } from "./subscription402";
import {
  bannerSeverityForTierName,
  ALERT_VARIANT_CLASS,
  SEVERITY_ICON,
  renewalAmount,
} from "./subscriptionBanner";
import PayFromNodeModal from "./PayFromNodeModal";
import { depositAddressDisplay, payBlocked, trustCopy } from "./paymentTrust";

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

export default function RoutingDeniedNotice({
  payload,
  blockedAction,
}: {
  payload: RoutingDeniedPayload;
  blockedAction: "send" | "receive";
}) {
  const [payModalOpen, setPayModalOpen] = useState(false);

  // Denied tiers are always gated (prepay / routing_lapsed / close_due);
  // fall back to amber for any unexpected tier so an unclassifiable block
  // still reads as "action needed" rather than crashing.
  const severity = bannerSeverityForTierName(payload.tier) ?? "amber";
  const price = fmtSats(payload.price_sats);
  const isPrepay = payload.tier === "prepay";

  const headline =
    blockedAction === "send"
      ? "Sending payments requires an active membership"
      : "Receiving through the hub requires an active membership";

  const standing = isPrepay
    ? "Your membership is not yet activated."
    : payload.paid_through
      ? `Services paused since ${formatDate(payload.paid_through)}.`
      : "Your subscription has lapsed.";

  const cta = isPrepay
    ? `Pay ${price} to activate.`
    : `Renew ${price} to restore access.`;

  // treasury-price-trust C15: the deposit address, and the pay modal that
  // carries it, render only from a status this node verified whose address is
  // the pinned one — read from the status proxy, never from the 402 payload,
  // which carries no verification label. Otherwise the S-state shows, with no
  // address, and the button degrades to the Settings panel as before.
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getSubscriptionStatus().then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const display = depositAddressDisplay(status);
  const canOpenModal = display.show;
  const trustState = !display.show ? display.state : null;
  // G3 finding 1 (ruled 2026-11-11): while payments are blocked, no line asks
  // for payment; the S-state shows alone. A status not yet loaded is blocked.
  const blocked = payBlocked(status);

  return (
    <>
      <div className={`alert ${ALERT_VARIANT_CLASS[severity]}`} style={{ flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span className="alert-icon" aria-hidden>{SEVERITY_ICON[severity]}</span>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{headline}</div>
            <div>{blocked ? standing : `${standing} ${cta}`}</div>
            {display.show && (
              <div style={{ marginTop: 6, fontSize: "0.75rem", opacity: 0.85 }}>
                Deposit address:{" "}
                <code className="ident" title={display.address}>
                  {truncPubkey(display.address)}
                </code>
              </div>
            )}
            {trustState && (
              <div style={{ marginTop: 6 }} data-trust-state={trustState.state}>
                {trustCopy(
                  trustState,
                  trustState.state === "S4_price_above_cap" ? renewalAmount(trustState.price_sats, null).text : undefined,
                ).text}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginLeft: 24 }}>
          {canOpenModal ? (
            <button className="btn btn-primary" onClick={() => setPayModalOpen(true)}>
              Pay now
            </button>
          ) : (
            <Link className="btn btn-primary" to="/settings">
              Go to subscription
            </Link>
          )}
        </div>
      </div>
      {payModalOpen && display.show && status?.applicable === true && (
        <PayFromNodeModal status={status} onClose={() => setPayModalOpen(false)} />
      )}
    </>
  );
}
