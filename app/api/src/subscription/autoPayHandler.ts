// Subscription auto-pay HTTP handlers (the logic-bearing ones).
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §8
// endpoints A (toggle), B (acknowledge), C (status). The thin history/dismiss
// routes call the store directly from index.ts (mirroring the autobuy routes).
//
// All three need the live subscription price, which on a member node reaches
// the node only inside the proxied treasury status — so they fetchLocalSubscription
// Status() rather than reading subscription_policy directly (auto-pay never
// reads policy on a member node).

import { db } from "../db";
import {
  getMemberProfile,
  setAutoPayEnabled,
  acknowledgePrice,
} from "../profile/profileStore";
import { fetchLocalSubscriptionStatus } from "./memberStatusClient";
import { priceChangePending } from "./priceChange";
import { getActiveAlerts, getBadgeCount, type AutoPayAlertView } from "./autoPayAlertStore";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Pull the live subscription price (sats) from the proxied status, or null if
 *  the status is unavailable / not applicable. */
async function currentPriceSats(): Promise<number | null> {
  const result = await fetchLocalSubscriptionStatus();
  if (!result.ok) return null;
  const s = result.status as any;
  return s.applicable === true && typeof s.price_sats === "number" ? s.price_sats : null;
}

export interface AutoPayConfigResponse {
  enabled: boolean;
  enabled_at: number | null;
  last_acknowledged_price: number | null;
  last_acknowledged_price_at: number | null;
  current_price: number | null;
  price_change_pending: boolean;
  active_alerts: AutoPayAlertView[];
  badge: { active_count: number; highest_severity: "info" | "warning" | null };
}

/** Endpoint C — GET /api/profile/auto-pay. One call feeds the Profile section,
 *  the Dashboard banner, and the nav badge. */
export async function getAutoPayConfig(memberPubkey: string): Promise<AutoPayConfigResponse> {
  const profile = getMemberProfile(memberPubkey);
  const enabled = profile?.auto_pay_enabled === 1;
  const lastAck = profile?.last_acknowledged_price ?? null;
  const current = await currentPriceSats();

  const pricePending =
    current != null &&
    priceChangePending({
      applicable: true,
      autoPayEnabled: enabled,
      currentPriceSats: current,
      lastAcknowledgedPrice: lastAck,
    });

  return {
    enabled,
    enabled_at: profile?.auto_pay_enabled_at ?? null,
    last_acknowledged_price: lastAck,
    last_acknowledged_price_at: profile?.last_acknowledged_price_at ?? null,
    current_price: current,
    price_change_pending: pricePending,
    active_alerts: getActiveAlerts(db, memberPubkey),
    badge: getBadgeCount(db, memberPubkey),
  };
}

/** Endpoint A — POST /api/profile/auto-pay { enabled }. On enable, seed
 *  last_acknowledged_price to the current price so the price-change banner
 *  starts silent. */
export async function setAutoPay(
  memberPubkey: string,
  enabled: boolean,
): Promise<{ enabled: boolean; enabled_at: number | null }> {
  const now = nowSec();
  if (enabled) {
    const seed = await currentPriceSats(); // null-safe: banner shows until first ack if unknown
    setAutoPayEnabled(memberPubkey, true, now, seed);
    return { enabled: true, enabled_at: now };
  }
  setAutoPayEnabled(memberPubkey, false, now);
  const profile = getMemberProfile(memberPubkey);
  return { enabled: false, enabled_at: profile?.auto_pay_enabled_at ?? null };
}

/** Endpoint B — POST /api/profile/acknowledge-price-change. Advances
 *  last_acknowledged_price to the current price (server-derived). */
export async function acknowledgePriceChange(
  memberPubkey: string,
): Promise<
  | { ok: true; acknowledged_price: number; acknowledged_at: number }
  | { ok: false; code: "status_unavailable"; detail: string }
> {
  const current = await currentPriceSats();
  if (current == null) {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "could not read the current subscription price from the treasury",
    };
  }
  const now = nowSec();
  acknowledgePrice(memberPubkey, current, now);
  return { ok: true, acknowledged_price: current, acknowledged_at: now };
}
