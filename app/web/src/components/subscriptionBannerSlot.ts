import type { SubscriptionStatus } from "../api/client";
import { gatedTierOf } from "./subscriptionBanner";

/**
 * J9 / J9a (P6-3): which slot the member dashboard gives the subscription
 * banner. On a phone the "top" slot renders above the headline numbers and the
 * "info" slot below them and the price chart (styles.css, the .dash order
 * rules); on desktop both keep their source order.
 *
 * J9a's test is what a banner SAYS: it stays on top when it says payments are
 * refused (routing_lapsed, "Urgent: routing access blocked") or a close is
 * coming (close_due, "Critical: channel close imminent"). prepay ("activate
 * your membership") and worker_lapsed ("hosted services lapsed … your channel
 * and routing still work") say neither, so they take the info slot — the
 * round 1 record's reading, ruled as P6-3.
 *
 * MemberSubscriptionBanner renders the price-change and auto-pay notices
 * beside the tier banner, so they share its slot.
 */
export type DashboardSlot = "top" | "info";

export function subscriptionBannerSlot(status: SubscriptionStatus | null): DashboardSlot {
  const tier = gatedTierOf(status);
  return tier === "routing_lapsed" || tier === "close_due" ? "top" : "info";
}
