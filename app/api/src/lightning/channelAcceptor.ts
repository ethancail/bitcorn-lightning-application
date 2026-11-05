// The treasury's channel gate: an LND ChannelAcceptor that admits an inbound
// open only from a paid member or a peer classified external.
//
// Spec: bitcorn-research specs/2026-11-05-membership-gating-spec.md §1 T4, T5
// (decisions D5, D6(b), D7; rulings R4–R7, R9; pass 10 items 2, 4, B).
//
// WHO IS ADMITTED (D6(b), R4, R9 first reading) — isOpenChannelAllowed():
//   - a peer the server classifier calls `external_peer` (the curated list,
//     ACINQ included, and the `external` / `external-peer` contact tags); or
//   - a subscriber whose row's current_tier is `current`: paid, or inside the
//     30-day renewal grace after paid_through. A member past + 30 is refused.
// Everything else is refused with ACCEPTOR_REJECT_REASON. Keys are matched in
// lowercase (subscription keys are stored lowercased; the classifier is
// already case-insensitive).
//
// ONE PREDICATE, TWO PATHS (R4). The same function produces the verdict the
// status response carries (openChannelVerdict → `open_channel_allowed`), so the
// member's app check and this acceptor cannot disagree.
//
// A THROWING PREDICATE ACCEPTS (R6): availability over the gate, as D7 chose.
// The error is recorded and raises the alert for an hour (T5, item 4).
//
// WHICH PROCESS (R9 second reading): the treasury's API process, and only while
// this node's own pubkey equals ENV.treasuryPubkey. The pubkey is re-read on
// every supervisor tick, because node info is written by the LND sync and may
// not exist yet at boot.
//
// THE STREAM (item B). ln-service's subscribeToOpenRequests drops errors unless
// an error listener is attached, emits `end` when the gRPC stream ends and never
// reconnects, and lives on the LND client it was opened with — which lnd.ts
// replaces when the TLS cert changes. So this module attaches an error listener,
// re-subscribes after `end` or `error`, and re-subscribes on the supervisor tick
// that finds getLndClient() returning a different client. An old stream is
// cancelled by removing its channel_request listeners (the library cancels the
// gRPC call when the last one goes); events from it are ignored after that.
//
// ACCEPTED RESIDUAL (item B): if the library fails to parse a request it emits
// an error and never answers, so LND times the open out and refuses it. That
// path does not reach the predicate, so R6's accept-on-error cannot cover it.
//
// WHAT THIS CANNOT SEE (spec T5): whether LND counts the stream as registered;
// a dead stream LND still holds (fails closed, looks like silence); its own
// downtime; other acceptors or RPC middleware; opens LND refuses before asking.
// Opens the treasury itself starts never reach an acceptor (R10, out of scope).

import type { EventEmitter } from "events";
import { subscribeToOpenRequests, type OpenRequest } from "ln-service";
import { db } from "../db";
import { ENV } from "../config/env";
import { getLndClient } from "./lnd";
import { classifyLanePurpose } from "../subscription/lanePurpose";
import type { TreasuryAlert } from "../api/treasury-alerts";

/** R7's acceptor text, verbatim. ASCII, under LND's 500-character limit.
 *  Every opener sees it, lncli included. */
export const ACCEPTOR_REJECT_REASON =
  "Opening a channel to the BitCorn hub requires a paid membership. " +
  "Pay your membership in the BitCorn app on your node, then try again.";

/** Re-subscribe this long after the stream ends or errors. */
export const RESUBSCRIBE_DELAY_MS = 5_000;
/** Supervisor cadence: role re-read and LND-client rebuild check. */
export const SUPERVISOR_INTERVAL_MS = 15_000;
/** A predicate error keeps the alert raised this long (item 4). */
export const PREDICATE_ERROR_WINDOW_MS = 60 * 60 * 1000;

// ─── The predicate ─────────────────────────────────────────────────────────

/**
 * T4's gate. Throws on a database error; callers decide what that means
 * (the acceptor accepts, the status verdict reports null).
 */
export function isOpenChannelAllowed(pubkey: string): boolean {
  const key = pubkey.toLowerCase();
  if (classifyLanePurpose(key) === "external_peer") return true;
  const row = db
    .prepare(`SELECT current_tier FROM subscription WHERE member_pubkey = ?`)
    .get(key) as { current_tier: string } | undefined;
  return row?.current_tier === "current";
}

/**
 * The verdict the status response carries as `open_channel_allowed` (item 2):
 * true, false, or null when the predicate could not be evaluated. Null means
 * unknown, and the member's app check lets an unknown verdict through for the
 * acceptor to decide (R4).
 */
export function openChannelVerdict(pubkey: string): boolean | null {
  try {
    return isOpenChannelAllowed(pubkey);
  } catch (err: any) {
    console.warn("[channel-gate] verdict unavailable:", err?.message ?? err);
    return null;
  }
}

// ─── State ─────────────────────────────────────────────────────────────────

interface ActiveStream {
  lnd: unknown;
  emitter: EventEmitter;
  generation: number;
}

let active: ActiveStream | null = null;
let generation = 0;
let isTreasuryNode = false;
let lastPredicateErrorAt: number | null = null;
let ownPubkeyFn: (() => string | null) | null = null;
let supervisorTimer: NodeJS.Timeout | null = null;
let resubscribeTimer: NodeJS.Timeout | null = null;

export type OpenRequestOutcome = "accepted" | "rejected" | "accepted_on_error";

/** Answers one inbound open. Exported for tests; the stream calls it. */
export function handleOpenRequest(request: OpenRequest, nowMs: number = Date.now()): OpenRequestOutcome {
  let allowed: boolean;
  try {
    allowed = isOpenChannelAllowed(request.partner_public_key);
  } catch (err: any) {
    lastPredicateErrorAt = nowMs;
    console.warn(
      `[channel-gate] predicate failed for ${request.partner_public_key}; accepting (R6):`,
      err?.message ?? err,
    );
    request.accept();
    return "accepted_on_error";
  }
  if (allowed) {
    request.accept();
    return "accepted";
  }
  console.log(`[channel-gate] refused an open from ${request.partner_public_key}`);
  request.reject({ reason: ACCEPTOR_REJECT_REASON });
  return "rejected";
}

function cancelActive(): void {
  if (!active) return;
  const old = active;
  active = null;
  // The library cancels the gRPC call when its last channel_request listener
  // is removed. The error/end listeners stay, and ignore the old generation.
  old.emitter.removeAllListeners("channel_request");
}

function scheduleResubscribe(): void {
  if (resubscribeTimer) return;
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    superviseChannelAcceptor();
  }, RESUBSCRIBE_DELAY_MS);
  resubscribeTimer.unref?.();
}

function subscribe(lnd: unknown): void {
  const gen = ++generation;
  let emitter: EventEmitter;
  try {
    emitter = subscribeToOpenRequests({ lnd });
  } catch (err: any) {
    console.warn("[channel-gate] could not open the acceptor stream:", err?.message ?? err);
    scheduleResubscribe();
    return;
  }
  const isCurrent = () => active?.generation === gen;
  emitter.on("error", (err: unknown) => {
    if (!isCurrent()) return;
    console.warn("[channel-gate] acceptor stream error; re-subscribing:", err);
    cancelActive();
    scheduleResubscribe();
  });
  emitter.on("end", () => {
    if (!isCurrent()) return;
    console.warn("[channel-gate] acceptor stream ended; re-subscribing");
    cancelActive();
    scheduleResubscribe();
  });
  emitter.on("channel_request", (request: OpenRequest) => {
    handleOpenRequest(request);
  });
  active = { lnd, emitter, generation: gen };
  console.log("[channel-gate] acceptor stream open");
}

/**
 * One supervisor pass: register when this node is the treasury and no stream
 * is open, re-register when the LND client has been rebuilt, stand down when
 * this node is not the treasury. Never throws.
 */
export function superviseChannelAcceptor(): void {
  const own = ownPubkeyFn?.() ?? null;
  const treasury = (ENV.treasuryPubkey ?? "").toLowerCase();
  isTreasuryNode = !!own && !!treasury && own.toLowerCase() === treasury;
  if (!isTreasuryNode) {
    cancelActive();
    return;
  }
  let lnd: unknown;
  try {
    lnd = getLndClient().lnd;
  } catch (err: any) {
    // No client means no stream; the alert reports it.
    if (active) console.warn("[channel-gate] LND client unavailable:", err?.message ?? err);
    cancelActive();
    return;
  }
  if (active && active.lnd === lnd) return;
  if (active) console.log("[channel-gate] LND client rebuilt; re-subscribing");
  cancelActive();
  subscribe(lnd);
}

/** Boot entry (index.ts main()). Runs a pass now and every SUPERVISOR_INTERVAL_MS. */
export function startChannelAcceptor(getOwnPubkey: () => string | null): void {
  ownPubkeyFn = getOwnPubkey;
  superviseChannelAcceptor();
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = setInterval(superviseChannelAcceptor, SUPERVISOR_INTERVAL_MS);
  supervisorTimer.unref?.();
}

/** Test seam: back to the state of a freshly loaded module. */
export function resetChannelAcceptorForTests(): void {
  if (supervisorTimer) clearInterval(supervisorTimer);
  if (resubscribeTimer) clearTimeout(resubscribeTimer);
  supervisorTimer = null;
  resubscribeTimer = null;
  cancelActive();
  generation = 0;
  isTreasuryNode = false;
  lastPredicateErrorAt = null;
  ownPubkeyFn = null;
}

// ─── Health and the alert (T5) ─────────────────────────────────────────────

export interface ChannelAcceptorHealth {
  /** The supervisor has found this node to be the treasury. */
  applicable: boolean;
  stream_open: boolean;
  last_predicate_error_at: number | null;
}

export function getChannelAcceptorHealth(): ChannelAcceptorHealth {
  return {
    applicable: isTreasuryNode,
    stream_open: active !== null,
    last_predicate_error_at: lastPredicateErrorAt,
  };
}

/**
 * R5's basic warning, with item 4's words and trigger: raised while the stream
 * isn't open, or when any predicate error occurred in the last hour.
 */
export function channelGateAlert(health: ChannelAcceptorHealth, nowMs: number): TreasuryAlert | null {
  if (!health.applicable) return null;
  const recentError =
    health.last_predicate_error_at !== null &&
    nowMs - health.last_predicate_error_at <= PREDICATE_ERROR_WINDOW_MS;
  if (health.stream_open && !recentError) return null;
  return {
    type: "CHANNEL_GATE_OFFLINE",
    heading: "Channel gate offline",
    severity: "warning",
    message:
      "The hub isn't checking new channel requests. Opens from unpaid members will be " +
      "accepted until it reconnects.",
    data: {
      stream_open: health.stream_open,
      last_predicate_error_at: health.last_predicate_error_at,
    },
    at: nowMs,
  };
}
