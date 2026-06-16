// Severity-aware, non-dismissible subscription banner for the member
// Dashboard (Direction B).
//
// Source of truth: specs/2026-06-11-subscription-discoverability-implementation.md §3
//
// A thin renderer over the pure bannerFor() descriptor — it adds no tier
// logic of its own. Renders only for the four payment-action tiers
// (prepay / worker_lapsed / routing_lapsed / close_due); returns null for
// current, every applicable:false reason, and a not-yet-fetched (null)
// status, so the page is pixel-identical to today when the member is
// healthy.
//
// Non-dismissible by design: subscription tiers are standing states, not
// discrete events. There is no close affordance and nothing in
// localStorage — the banner clears when the 60s status poll observes a
// tier transition out of the gated set. The only way to dismiss it is to
// pay, and the banner carries the way to do that (inline PayFromNodeModal,
// the modal's first mount outside Settings).

import { useState } from "react";
import { Link } from "react-router-dom";
import type { SubscriptionStatus } from "../api/client";
import { bannerFor, ALERT_VARIANT_CLASS, SEVERITY_ICON } from "./subscriptionBanner";
import PayFromNodeModal from "./PayFromNodeModal";

export default function MemberSubscriptionBanner({
  status,
}: {
  status: SubscriptionStatus | null;
}) {
  const [payModalOpen, setPayModalOpen] = useState(false);
  const descriptor = bannerFor(status, Date.now());

  // The descriptor's render flag already filters null / not-applicable /
  // current; the applicable narrowing here is what lets us hand the modal
  // a SubscriptionStatusApplicable. Both conditions hold together when
  // render is true, but TypeScript needs the explicit narrow.
  if (!descriptor.render || !status || status.applicable !== true) return null;

  const severity = descriptor.severity!;

  return (
    <>
      <div className={`alert ${ALERT_VARIANT_CLASS[severity]} member-sub-banner`}>
        <span className="alert-icon" aria-hidden>{SEVERITY_ICON[severity]}</span>
        <div className="member-sub-banner-body">
          <div className="member-sub-banner-headline">{descriptor.headline}</div>
          <div>{descriptor.body}</div>
          <Link className="member-sub-banner-link" to="/settings">
            View subscription →
          </Link>
        </div>
        <button
          className="btn btn-primary member-sub-banner-action"
          onClick={() => setPayModalOpen(true)}
        >
          {descriptor.actionLabel}
        </button>
      </div>
      {payModalOpen && (
        <PayFromNodeModal status={status} onClose={() => setPayModalOpen(false)} />
      )}
    </>
  );
}
