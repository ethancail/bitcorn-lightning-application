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
import { SUBSCRIPTION_PRICE_CAP_SATS, checkSubscriptionPrice, type PriceRefusalCode } from "./priceCap";
import { getActiveAlerts, getBadgeCount, type AutoPayAlertView } from "./autoPayAlertStore";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** The live subscription price, from the VERIFIED status only
 *  (treasury-price-trust spec §4 R10, §5 E4). It seeds and raises the D3
 *  ceiling, so an unverified, fractional or over-cap price is never returned
 *  as a price — each is its own variant, so the caller says why. */
type CurrentPrice =
  | { kind: "ok"; price: number }
  | { kind: "unavailable" }
  | {
      kind: "unverified";
      verdict: "unsigned" | "invalid" | "unverifiable";
      verification_reason?: "key_unset" | "lnd_unavailable";
    }
  | { kind: "refused"; code: PriceRefusalCode; detail: string; price: number };

async function currentPriceSats(): Promise<CurrentPrice> {
  const result = await fetchLocalSubscriptionStatus();
  if (!result.ok) {
    return result.code === "status_unverified"
      ? { kind: "unverified", verdict: result.verdict, verification_reason: result.verification_reason }
      : { kind: "unavailable" };
  }
  const s = result.status as any;
  if (s.applicable !== true || typeof s.price_sats !== "number") return { kind: "unavailable" };
  const check = checkSubscriptionPrice(s.price_sats, SUBSCRIPTION_PRICE_CAP_SATS);
  return check.ok
    ? { kind: "ok", price: s.price_sats }
    : { kind: "refused", code: check.code, detail: check.detail, price: s.price_sats };
}

export interface AutoPayConfigResponse {
  enabled: boolean;
  enabled_at: number | null;
  last_acknowledged_price: number | null;
  last_acknowledged_price_at: number | null;
  current_price: number | null;
  price_change_pending: boolean;
  /** treasury-price-trust (spec §4 R10, §8): the status's verdict, or null
   *  when the treasury could not be read at all. */
  status_verification: "verified" | "unsigned" | "invalid" | "unverifiable" | null;
  status_verification_reason: "key_unset" | "lnd_unavailable" | null;
  /** A verified price this app will not pay (S4, S5), or null. */
  price_refusal: PriceRefusalCode | null;
  active_alerts: AutoPayAlertView[];
  badge: { active_count: number; highest_severity: "info" | "warning" | null };
}

/** Endpoint C — GET /api/profile/auto-pay. One call feeds the Profile section,
 *  the Dashboard banner, and the nav badge. */
export async function getAutoPayConfig(memberPubkey: string): Promise<AutoPayConfigResponse> {
  const profile = getMemberProfile(memberPubkey);
  const enabled = profile?.auto_pay_enabled === 1;
  const lastAck = profile?.last_acknowledged_price ?? null;
  const live = await currentPriceSats();
  const current = live.kind === "ok" ? live.price : null;

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
    status_verification:
      live.kind === "unverified" ? live.verdict : live.kind === "unavailable" ? null : "verified",
    status_verification_reason: live.kind === "unverified" ? live.verification_reason ?? null : null,
    price_refusal: live.kind === "refused" ? live.code : null,
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
    // The seed sets the D3 ceiling, so only a verified, integer, capped price
    // seeds it (E4); otherwise NULL, and auto-pay refuses price_unacknowledged
    // until a verified acknowledgement.
    const live = await currentPriceSats();
    const seed = live.kind === "ok" ? live.price : null;
    setAutoPayEnabled(memberPubkey, true, now, seed);
    return { enabled: true, enabled_at: now };
  }
  setAutoPayEnabled(memberPubkey, false, now);
  const profile = getMemberProfile(memberPubkey);
  return { enabled: false, enabled_at: profile?.auto_pay_enabled_at ?? null };
}

/** Endpoint B — POST /api/profile/acknowledge-price-change { price_sats }.
 *  Records the price the member was SHOWN as last_acknowledged_price, and only
 *  if it is still the current (server-derived) price: a mismatch records
 *  nothing, so the member can never acknowledge a price they did not see
 *  (pay-from-node spec §4.1, §6 Q6 ruled 2026-11-05). That price is the
 *  ceiling both payment paths enforce (D3), and this route never lowers it:
 *  it stores the higher of the stored and the acknowledged price. Body
 *  validation in the handler, not a confirmation: the route stays exempt
 *  ("local flag"). */
export async function acknowledgePriceChange(
  memberPubkey: string,
  shownPriceSats: number,
): Promise<
  | { ok: true; acknowledged_price: number; acknowledged_at: number }
  | { ok: false; code: "status_unavailable"; detail: string }
  | {
      ok: false;
      code: "status_unverified";
      detail: string;
      reason: "unsigned" | "invalid" | "unverifiable";
      verification_reason?: "key_unset" | "lnd_unavailable";
    }
  | { ok: false; code: PriceRefusalCode; detail: string; price_sats: number }
  | { ok: false; code: "acknowledged_price_mismatch"; detail: string }
> {
  const live = await currentPriceSats();
  if (live.kind === "unverified") {
    // It sets the ceiling: records nothing from an unverified body (§4 R10).
    return {
      ok: false,
      code: "status_unverified",
      detail: "the subscription price could not be verified as the treasury's; nothing was recorded",
      reason: live.verdict,
      ...(live.verification_reason ? { verification_reason: live.verification_reason } : {}),
    };
  }
  if (live.kind === "refused") {
    // Neither refusal can be acknowledged (§5, C6b).
    return { ok: false, code: live.code, detail: live.detail, price_sats: live.price };
  }
  if (live.kind === "unavailable") {
    return {
      ok: false,
      code: "status_unavailable",
      detail: "could not read the current subscription price from the treasury",
    };
  }
  const current = live.price;
  if (current !== shownPriceSats) {
    return {
      ok: false,
      code: "acknowledged_price_mismatch",
      detail: "the subscription price changed since it was shown; nothing was recorded",
    };
  }
  // Never lowers the ceiling (ruled 2026-11-05): store the higher of the
  // stored and the acknowledged price.
  const stored = getMemberProfile(memberPubkey)?.last_acknowledged_price ?? null;
  const recorded = stored != null && stored > current ? stored : current;
  const now = nowSec();
  acknowledgePrice(memberPubkey, recorded, now);
  return { ok: true, acknowledged_price: recorded, acknowledged_at: now };
}
