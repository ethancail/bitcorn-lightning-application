// Subscription auto-pay scheduler — member-node-local renewal tick.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §3.
//
// The architectural crux (verified at Gate 1): no existing member-side process
// observes the member's own tier with the browser closed. observeTierForTransition
// fires only on browser-driven status polls, and the detector/tier3 loops starve
// on a member's empty subscription table. Auto-pay exists precisely for the
// absent member, so it needs this dedicated scheduler.
//
// It is a THIN orchestrator: fetch the member's own status, reduce it to a tier,
// ask the pure shouldAutoPay trigger what to do, and either run executePayFromNode
// (the same entry point the manual modal uses — one shared in-flight lock) or
// no-op. All decision logic is pure (autoPayTrigger.ts); all error→alert
// classification is pure (autoPayAlerts.ts). The tick never throws.
//
// Runs on ALL nodes but acts only on members — the runOnce() guard skips
// treasury, so a node that transitions to member role picks it up.

import { db } from "../db";
import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { getMemberProfile } from "../profile/profileStore";
import { fetchLocalSubscriptionStatus } from "./memberStatusClient";
import {
  executePayFromNode,
  isSendInFlight,
  parseCreditState,
  parseStatusForPayment,
  payTargetRefusal,
} from "./payFromNode";
import { shouldAutoPay, type AutoPayTier } from "./autoPayTrigger";
import {
  classifyAutoPayError,
  currentPriceCauseKey,
  overdueCauseKey,
  payTargetCauseKey,
  priceCauseKey,
  unverifiedCauseKey,
  type PriceAlertReason,
} from "./autoPayAlerts";
import { getCurrentPin } from "./depositAddressPin";
import { SUBSCRIPTION_PRICE_CAP_SATS } from "./priceCap";
import {
  getActiveAlerts,
  recordAutoPaySuccess,
  recordAutoPayFailure,
  recordCauseAlert,
  resolveClearedCauseAlerts,
  resolveStaleSucceeded,
} from "./autoPayAlertStore";
import { clearMarkersOnCredit, listActiveMarkers } from "./sendMarker";

// AUTOPAY_SUCCEEDED auto-resolves after this window (Gate-1 rec C: 24h or next
// lapse episode). Not env-tunable — it is a UX lifetime, not a safety knob.
const SUCCEEDED_TTL_SEC = 24 * 3600;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false; // skip overlapping ticks (the async runOnce may still be in flight)
// The episode an AUTOPAY_STATUS_UNVERIFIED alert belongs to: the last verified
// status this process saw, or process start (unverifiedCauseKey).
let lastVerifiedAtSec = Math.floor(Date.now() / 1000);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** One scheduler tick. Exported so the tests can drive a tick directly. */
export async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const node = getNodeInfo();
    // Member nodes only (skip treasury); need a pubkey to scope alerts.
    if (!node || node.node_role === "treasury" || !node.pubkey) return;
    const memberPubkey = node.pubkey;

    // Housekeeping: retire stale SUCCEEDED notifications (24h lifecycle).
    resolveStaleSucceeded(db, memberPubkey, nowSec() - SUCCEEDED_TTL_SEC);

    const profile = getMemberProfile(memberPubkey);
    const autoPayEnabled = profile?.auto_pay_enabled === 1;

    // Observe the member's own tier (browser-independent), through the one
    // verifying fetch. Unreachable / no cached token is a silent deferral, no
    // alert. An UNVERIFIED status counts as no status for every actor below
    // (treasury-price-trust spec §4): the trigger does not run, no marker is
    // cleared, no alert is housekept — and, if auto-pay is on, the member is
    // told why (AUTOPAY_STATUS_UNVERIFIED), once per episode.
    const statusResult = await fetchLocalSubscriptionStatus();
    if (!statusResult.ok) {
      if (statusResult.code === "status_unverified") {
        const key = unverifiedCauseKey(
          statusResult.verdict,
          statusResult.verification_reason,
          lastVerifiedAtSec,
        );
        if (autoPayEnabled) {
          recordCauseAlert(db, memberPubkey, {
            type: "AUTOPAY_STATUS_UNVERIFIED",
            causeKey: key,
            context: {
              verdict: statusResult.verdict,
              verification_reason: statusResult.verification_reason ?? null,
              detail: statusResult.detail,
            },
          });
        }
        resolveClearedCauseAlerts(
          db,
          memberPubkey,
          "AUTOPAY_STATUS_UNVERIFIED",
          new Set(autoPayEnabled ? [key] : []),
        );
        if (ENV.debug) {
          console.log(`[autopay] status not verified (${statusResult.verdict}); not acting on it`);
        }
        return;
      }
      if (ENV.debug) {
        console.log(`[autopay] status unavailable (${statusResult.code}); deferring`);
      }
      return;
    }
    const status = statusResult.status;
    lastVerifiedAtSec = nowSec();
    resolveClearedCauseAlerts(db, memberPubkey, "AUTOPAY_STATUS_UNVERIFIED", new Set());
    const tier: AutoPayTier =
      status.applicable === true ? (status.current_tier as AutoPayTier) : null;

    // The pay-target alert resolves when its cause no longer holds on a
    // verified status: the price is integer and capped, and the address is
    // the pin (spec §5, §6.3).
    const liveTarget = status.applicable === true ? parseStatusForPayment(status) : null;
    const liveRefusal = liveTarget
      ? payTargetRefusal(
          liveTarget,
          getCurrentPin(db, memberPubkey)?.deposit_address ?? null,
          SUBSCRIPTION_PRICE_CAP_SATS,
        )
      : null;
    resolveClearedCauseAlerts(
      db,
      memberPubkey,
      "AUTOPAY_PAY_TARGET_REFUSED",
      new Set(liveRefusal ? [payTargetCauseKey(liveRefusal.code, liveRefusal)] : []),
    );

    // The pay-from-node guards' housekeeping, every tick and whatever the
    // trigger decides (spec §3.6, §4.3): clear send markers the status shows
    // credited, then resolve each guard alert whose cause no longer holds.
    clearMarkersOnCredit(db, memberPubkey, parseCreditState(status), nowSec());
    resolveClearedCauseAlerts(
      db,
      memberPubkey,
      "AUTOPAY_SETTLEMENT_OVERDUE",
      new Set(listActiveMarkers(db, memberPubkey).map((m) => overdueCauseKey(m.id))),
    );
    if (status.applicable === true && typeof status.price_sats === "number") {
      const liveKey = currentPriceCauseKey(
        status.price_sats,
        profile?.last_acknowledged_price ?? null,
      );
      resolveClearedCauseAlerts(
        db,
        memberPubkey,
        "AUTOPAY_PRICE_NOT_ACKNOWLEDGED",
        new Set(liveKey ? [liveKey] : []),
      );
    }

    const decision = shouldAutoPay({
      tier,
      autoPayEnabled,
      sendInFlight: isSendInFlight(),
      activeAlerts: getActiveAlerts(db, memberPubkey),
      nowSec: nowSec(),
      settlementCooldownSec: Math.floor(ENV.autoPaySettlementCooldownMs / 1000),
      failureBackoffSec: Math.floor(ENV.autoPayFailureBackoffMs / 1000),
      failurePauseThreshold: ENV.autoPayFailurePauseThreshold,
    });

    if (decision !== "fire") {
      if (ENV.debug && decision === "defer") {
        console.log(`[autopay] tier=${tier} enabled=${autoPayEnabled} → defer`);
      }
      return;
    }

    console.log(`[autopay] firing renewal — observed tier=${tier}`);
    const result = await executePayFromNode({ origin: "auto", memberPubkey });
    if (result.ok) {
      console.log(`[autopay] renewal sent — txid=${result.txid} amount=${result.price_sats} sats`);
      recordAutoPaySuccess(db, memberPubkey, {
        txid: result.txid,
        price_sats: result.price_sats,
      });
      return;
    }

    // Failure: classify to an alert type. The deferral cases
    // (status_unavailable / payment_in_flight / settlement_pending below the
    // hold time) classify to null → no alert, retry next tick.
    const alertType = classifyAutoPayError(result.code);
    if (!alertType) {
      if (result.code === "status_incomplete") {
        // Logged whatever the debug setting: a malformed treasury status, not
        // a transient outage, and it holds auto-pay until the status is fixed.
        console.warn(`[autopay] renewal refused — ${result.code}: ${result.detail}`);
      } else if (ENV.debug) {
        console.log(`[autopay] deferred (${result.code}); no alert`);
      }
      return;
    }
    console.warn(`[autopay] renewal failed — ${result.code}: ${result.detail}`);

    // The guard refusals: one alert per cause, never fed to the backoff.
    if (alertType === "AUTOPAY_SETTLEMENT_OVERDUE" && result.marker) {
      recordCauseAlert(db, memberPubkey, {
        type: alertType,
        causeKey: overdueCauseKey(result.marker.id),
        context: {
          error_code: result.code,
          detail: result.detail,
          marker_id: result.marker.id,
          marker_created_at: result.marker.created_at,
          amount_sats: result.marker.amount_sats,
          txid: result.marker.txid,
        },
      });
      return;
    }
    if (alertType === "AUTOPAY_PRICE_NOT_ACKNOWLEDGED" && result.price_sats != null) {
      const reason: PriceAlertReason =
        result.code === "price_unacknowledged" ? "no_acknowledged_price" : "price_above_acknowledged";
      const acknowledged = result.acknowledged_price_sats ?? null;
      recordCauseAlert(db, memberPubkey, {
        type: alertType,
        causeKey: priceCauseKey(reason, result.price_sats, acknowledged),
        context: {
          error_code: result.code,
          detail: result.detail,
          reason,
          price_sats: result.price_sats,
          acknowledged_price_sats: acknowledged,
        },
      });
      return;
    }
    // treasury-price-trust: one alert per cause, never fed to the backoff.
    if (alertType === "AUTOPAY_STATUS_UNVERIFIED" && result.reason) {
      recordCauseAlert(db, memberPubkey, {
        type: alertType,
        causeKey: unverifiedCauseKey(result.reason, result.verification_reason, lastVerifiedAtSec),
        context: {
          error_code: result.code,
          detail: result.detail,
          verdict: result.reason,
          verification_reason: result.verification_reason ?? null,
        },
      });
      return;
    }
    if (
      alertType === "AUTOPAY_PAY_TARGET_REFUSED" &&
      (result.code === "price_above_cap" ||
        result.code === "price_not_integer" ||
        result.code === "deposit_address_changed")
    ) {
      recordCauseAlert(db, memberPubkey, {
        type: alertType,
        causeKey: payTargetCauseKey(result.code, result),
        context: {
          error_code: result.code,
          detail: result.detail,
          reason: result.code,
          price_sats: result.price_sats ?? null,
          pinned_address: result.pinned_address ?? null,
          stated_address: result.stated_address ?? null,
        },
      });
      return;
    }
    recordAutoPayFailure(db, memberPubkey, {
      type: alertType,
      context: {
        error_code: result.code,
        detail: result.detail,
        price_sats: result.price_sats ?? null,
        balance_sats: result.balance_sats ?? null,
        estimated_fee_sats: result.estimated_fee_sats ?? null,
      },
    });
  } catch (err: any) {
    // Never let a tick throw — alerting/auto-pay is additive.
    console.error("[autopay] tick failed:", err?.message ?? String(err));
  } finally {
    running = false;
  }
}

export function startAutoPayScheduler(): void {
  const intervalMs = ENV.autoPayPollIntervalMs;
  console.log(
    `[autopay] starting scheduler (${Math.round(intervalMs / 1000)}s interval, member nodes only)`,
  );
  // Short startup delay so LND + the token-refresh first tick can settle
  // (mirrors the member advisor's 5s startup delay).
  setTimeout(() => void runOnce(), 5_000);
  intervalHandle = setInterval(() => void runOnce(), intervalMs);
}

export function stopAutoPayScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
