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

import { useState } from "react";
import { Link } from "react-router-dom";
import { fmtSats, truncPubkey } from "../api/client";
import type { RoutingDeniedPayload } from "./subscription402";
import {
  bannerSeverityForTierName,
  ALERT_VARIANT_CLASS,
  SEVERITY_ICON,
} from "./subscriptionBanner";
import PayFromNodeModal from "./PayFromNodeModal";

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

  // deposit_address is nullable by type (Tier2DenialBody). With an address
  // the inline modal handles payment; without one we degrade to the
  // Settings panel, which can render the richer not-ready states.
  const canOpenModal = payload.deposit_address != null;

  return (
    <>
      <div className={`alert ${ALERT_VARIANT_CLASS[severity]}`} style={{ flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span className="alert-icon" aria-hidden>{SEVERITY_ICON[severity]}</span>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{headline}</div>
            <div>{standing} {cta}</div>
            {payload.deposit_address && (
              <div style={{ marginTop: 6, fontSize: "0.75rem", opacity: 0.85 }}>
                Deposit address:{" "}
                <code title={payload.deposit_address}>
                  {truncPubkey(payload.deposit_address)}
                </code>
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
      {payModalOpen && payload.deposit_address && (
        <PayFromNodeModal
          status={{ price_sats: payload.price_sats, deposit_address: payload.deposit_address }}
          onClose={() => setPayModalOpen(false)}
        />
      )}
    </>
  );
}
