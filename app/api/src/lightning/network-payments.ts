import { db } from "../db";
import { decodePaymentRequest } from "ln-service";
import { createLndInvoice, getLndClient } from "./lnd";
// decodePaymentRequest is called directly off getLndClient()'s handle rather
// than through an lnd.ts wrapper, so it binds its own deadline. Decode consults
// the gossip graph to resolve routing hints, hence the gossip class.
import { withDeadline, LND_GOSSIP_CALL_TIMEOUT_MS } from "./callDeadline";
import { payInvoice } from "./pay";
import { getHubChannel } from "./hubChannel";
import { capacityOf } from "./capacity";
import { insertOutboundPayment } from "./persist-payments";
import { assertRateLimit } from "../utils/rate-limit";
import { ENV } from "../config/env";
import { findContactByPubkey } from "../utils/contact-pubkey";
import { getBtcUsd } from "../price/btcUsdCache";

/** Resolve a pubkey to a contact name for error messages — the same row lane classification uses. */
function resolveContact(pubkey: string): string {
  const row = findContactByPubkey(pubkey);
  return row?.name ?? `${pubkey.slice(0, 12)}…`;
}

// ─── Exchange rate ───────────────────────────────────────────────────────────

function satsToUsd(sats: number, rateUsd: number): number {
  return Math.round(((sats / 100_000_000) * rateUsd) * 100) / 100;
}

/** The cached rate, for a per-record USD amount — only when it is fresh
 *  (R18(9), drive-mode P1 item 3). Read, never fetched: no payment waits on
 *  Coinbase. */
function freshRateUsd(): number | null {
  const r = getBtcUsd();
  return r.state === "fresh" ? r.usd : null;
}

// ─── Invoice creation (Request Payment) ──────────────────────────────────────

export interface InvoiceResult {
  payment_hash: string;
  payment_request: string;
  amount_sats: number;
  amount_usd: number | null;
  exchange_rate_usd: number | null;
}

export async function createPaymentInvoice(
  amountSats: number,
  memo?: string
): Promise<InvoiceResult> {
  if (amountSats <= 0) throw new Error("Amount must be positive");

  const invoice = await createLndInvoice(amountSats, memo);
  const exchangeRate = freshRateUsd();
  const amountUsd = exchangeRate ? satsToUsd(amountSats, exchangeRate) : null;

  db.prepare(`
    INSERT INTO network_payments
    (payment_hash, direction, status, amount_sats, exchange_rate_usd, amount_usd, memo, payment_request, created_at)
    VALUES (?, 'receive', 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    invoice.id,
    amountSats,
    exchangeRate,
    amountUsd,
    memo ?? null,
    invoice.request,
    Date.now()
  );

  return {
    payment_hash: invoice.id,
    payment_request: invoice.request,
    amount_sats: amountSats,
    amount_usd: amountUsd,
    exchange_rate_usd: exchangeRate,
  };
}

// ─── Invoice decoding (preview before pay) ───────────────────────────────────

export interface DecodedInvoice {
  id: string;
  destination: string;
  tokens: number;
  description: string | null;
  expires_at: string | null;
}

export async function decodeInvoice(paymentRequest: string): Promise<DecodedInvoice> {
  const { lnd } = getLndClient();
  const decoded = await withDeadline(
    "decodeInvoice",
    () => decodePaymentRequest({ lnd, request: paymentRequest }),
    LND_GOSSIP_CALL_TIMEOUT_MS,
  );
  return {
    id: decoded.id,
    destination: decoded.destination,
    tokens: decoded.tokens,
    description: decoded.description ?? null,
    expires_at: decoded.expires_at ?? null,
  };
}

// ─── Pay invoice (Pay Invoice flow) ──────────────────────────────────────────

export interface PaymentResult {
  ok: boolean;
  payment_hash: string;
  amount_sats: number;
  fee_sats: number;
  amount_usd: number | null;
  destination: string;
  memo: string | null;
  error?: string;
}

export async function payNetworkInvoice(
  paymentRequest: string
): Promise<PaymentResult> {
  const { lnd } = getLndClient();
  // ⚠ THE DECODE IS BOUNDED; THE PAYMENT IT PRECEDES IS NOT. payInvoice() below
  // goes through pay.ts, whose payViaPaymentRequest is held unbounded. Bounding
  // the decode is safe precisely because it commits nothing — it is a read of
  // the request plus the gossip graph, and failing it means no payment was
  // attempted at all.
  const decoded = await withDeadline(
    "payNetworkInvoice:decode",
    () => decodePaymentRequest({ lnd, request: paymentRequest }),
    LND_GOSSIP_CALL_TIMEOUT_MS,
  );
  const { id: paymentHash, destination, tokens, description } = decoded;

  assertRateLimit(tokens);

  // Pre-flight: check if we have enough channel capacity to send this payment.
  // Look at channels to the destination (direct peer) and total spendable across all channels.
  const directChannels = db.prepare(`
    SELECT channel_id, local_balance_sat, remote_balance_sat, capacity_sat, active, local_reserve_sat
    FROM lnd_channels WHERE peer_pubkey = ? AND active = 1
  `).all(destination) as Array<{ channel_id: string; local_balance_sat: number; remote_balance_sat: number; capacity_sat: number; active: number; local_reserve_sat: number | null }>;

  const allActiveChannels = db.prepare(`
    SELECT COALESCE(SUM(local_balance_sat), 0) AS total_local
    FROM lnd_channels WHERE active = 1
  `).get() as { total_local: number };

  if (directChannels.length > 0) {
    // Direct peer — payment goes through one of these channels. A payment to
    // the treasury itself is pinned to the hub channel (pay.ts), so it is
    // checked against that channel: the hub rule, R18(3), drive-mode P1 item 1.
    const hub = destination === ENV.treasuryPubkey ? getHubChannel() : null;
    const bestChannel = hub ?? directChannels.reduce((best, ch) =>
      ch.local_balance_sat > best.local_balance_sat ? ch : best, directChannels[0]);
    // Room to send: local − the channel's real reserve (drive-mode P1 item 2).
    const spendable = capacityOf(bestChannel).room_to_send_sats;

    if (spendable < tokens) {
      const totalDirectLocal = directChannels.reduce((sum, ch) => sum + ch.local_balance_sat, 0);
      let reason = `Insufficient channel capacity to ${resolveContact(destination)}. `;
      reason += `You need ${tokens.toLocaleString()} sats but your best channel has ${spendable.toLocaleString()} spendable`;
      if (directChannels.length > 1) {
        reason += ` (${totalDirectLocal.toLocaleString()} total across ${directChannels.length} channels, but Lightning cannot combine them for direct peer payments)`;
      }
      reason += ". Open a larger channel to this peer.";
      throw new Error(reason);
    }
  } else {
    // Routed payment — member payments are forced through the treasury channel.
    // Check treasury channel balance specifically, not total across all channels.
    // The same channel pay.ts pins (drive-mode P1 item 1).
    const treasuryChannel = getHubChannel() ?? undefined;

    if (treasuryChannel) {
      // Room to send: local − the channel's real reserve (drive-mode P1 item 2).
      const spendable = capacityOf(treasuryChannel).room_to_send_sats;
      if (spendable < tokens) {
        throw new Error(
          `Insufficient outbound on treasury channel to send ${tokens.toLocaleString()} sats. ` +
          `You have ${spendable.toLocaleString()} sats available on the hub channel.`
        );
      }
    } else if (allActiveChannels.total_local < tokens) {
      throw new Error(
        `Insufficient Lightning balance to send ${tokens.toLocaleString()} sats. ` +
        `You have ${allActiveChannels.total_local.toLocaleString()} sats available.`
      );
    }
  }

  const exchangeRate = freshRateUsd();
  const amountUsd = exchangeRate ? satsToUsd(tokens, exchangeRate) : null;

  // Record pending payment
  db.prepare(`
    INSERT INTO network_payments
    (payment_hash, direction, status, amount_sats, exchange_rate_usd, amount_usd, memo, counterparty_pubkey, payment_request, created_at)
    VALUES (?, 'send', 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    paymentHash,
    tokens,
    exchangeRate,
    amountUsd,
    description ?? null,
    destination,
    paymentRequest,
    Date.now()
  );

  try {
    const result = await payInvoice(paymentRequest);

    // Update to succeeded
    db.prepare(`
      UPDATE network_payments
      SET status = 'succeeded', fee_sats = ?, settled_at = ?
      WHERE payment_hash = ? AND direction = 'send'
    `).run(result.fee, Date.now(), paymentHash);

    // Also record in payments_outbound for compatibility
    insertOutboundPayment({
      payment_hash: result.id,
      payment_request: paymentRequest,
      destination,
      tokens: result.tokens,
      fee: result.fee,
      status: "succeeded",
    });

    return {
      ok: true,
      payment_hash: result.id,
      amount_sats: result.tokens,
      fee_sats: result.fee,
      amount_usd: amountUsd,
      destination,
      memo: description ?? null,
    };
  } catch (err: any) {
    // Tier 2 routing-gate denial: payInvoice threw before any outbound
    // attempt. Mark the pending row failed and RE-THROW so the route
    // handler returns the structured 402 Tier2DenialBody (tier /
    // paid_through / deposit_address / price_sats) that the point-of-block
    // remediation UI consumes — rather than collapsing it into a generic
    // PaymentResult whose error string the frontend can't parse. Skip the
    // payments_outbound record: there was no outbound to account for.
    if (err?.name === "Tier2Denied") {
      db.prepare(`
        UPDATE network_payments
        SET status = 'failed'
        WHERE payment_hash = ? AND direction = 'send'
      `).run(paymentHash);
      throw err;
    }

    // Update to failed
    db.prepare(`
      UPDATE network_payments
      SET status = 'failed'
      WHERE payment_hash = ? AND direction = 'send'
    `).run(paymentHash);

    // Also record failed in payments_outbound
    insertOutboundPayment({
      payment_hash: paymentHash,
      payment_request: paymentRequest,
      destination,
      tokens,
      fee: 0,
      status: "failed",
    });

    // Translate LND errors into human-readable messages
    let errorMsg = err.message || String(err);
    if (errorMsg.includes("PaymentPathfindingFailedToFindPossibleRoute")) {
      errorMsg = `No route found to ${resolveContact(destination)}. Check that you have a channel with enough outbound capacity.`;
    } else if (errorMsg.includes("PaymentRejectedByDestination")) {
      errorMsg = `Payment rejected by ${resolveContact(destination)}. The invoice may have expired or already been paid.`;
    } else if (errorMsg.includes("PaymentAttemptTimedOut")) {
      errorMsg = `Payment to ${resolveContact(destination)} timed out. The route may be congested — try again later.`;
    } else if (errorMsg.includes("InsufficientBalance")) {
      errorMsg = `Insufficient outbound capacity to send ${tokens.toLocaleString()} sats. Your hub channel may not have enough balance.`;
    }

    return {
      ok: false,
      payment_hash: paymentHash,
      amount_sats: tokens,
      fee_sats: 0,
      amount_usd: amountUsd,
      destination,
      memo: description ?? null,
      error: errorMsg,
    };
  }
}

// ─── Payment history ─────────────────────────────────────────────────────────

export interface NetworkPayment {
  id: number;
  payment_hash: string;
  direction: "send" | "receive";
  status: "pending" | "succeeded" | "failed" | "expired";
  amount_sats: number;
  fee_sats: number;
  exchange_rate_usd: number | null;
  amount_usd: number | null;
  memo: string | null;
  counterparty_pubkey: string | null;
  payment_request: string | null;
  created_at: number;
  settled_at: number | null;
  /** Drive-mode P1 item 5: what fee_sats means for this row, derived from
   *  status (fee_sats is NOT NULL DEFAULT 0, so 0 alone is ambiguous). */
  fee_state: FeeState;
}

/** paid: a send that settled with a fee > 0; zero: a send that settled for no
 *  fee; pending: a send not yet settled; failed: a send that failed or
 *  expired, which pays no fee; none: a receive, which pays none. */
export type FeeState = "paid" | "zero" | "pending" | "failed" | "none";

export function feeStateOf(p: { direction: string; status: string; fee_sats: number }): FeeState {
  if (p.direction !== "send") return "none";
  if (p.status === "pending") return "pending";
  if (p.status === "failed" || p.status === "expired") return "failed";
  return p.fee_sats > 0 ? "paid" : "zero";
}

export function getNetworkPayments(options?: {
  direction?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): NetworkPayment[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.direction) {
    conditions.push("direction = ?");
    params.push(options.direction);
  }
  if (options?.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const rows = db.prepare(`
    SELECT * FROM network_payments
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Omit<NetworkPayment, "fee_state">[];
  return rows.map((r) => ({ ...r, fee_state: feeStateOf(r) }));
}

// ─── Settlement sync ─────────────────────────────────────────────────────────

export function syncNetworkInvoiceSettlements(): { updated: number } {
  // Find pending receive payments whose payment_hash now appears in payments_inbound
  const pending = db.prepare(`
    SELECT np.id, np.payment_hash, np.counterparty_pubkey
    FROM network_payments np
    WHERE np.direction = 'receive' AND np.status = 'pending'
  `).all() as Array<{ id: number; payment_hash: string; counterparty_pubkey: string | null }>;

  let updated = 0;
  const now = Date.now();

  // Infer counterparty for received payments:
  // On member nodes, all payments arrive through the treasury channel → counterparty is treasury.
  // On treasury nodes, try to resolve from forwarding records (incoming_channel → peer).
  const nodeInfo = db.prepare("SELECT node_role, pubkey FROM lnd_node_info WHERE id = 1").get() as
    { node_role: string; pubkey: string } | undefined;
  const isTreasury = nodeInfo?.node_role === "treasury";

  for (const p of pending) {
    const settled = db.prepare(`
      SELECT settled_at FROM payments_inbound WHERE payment_hash = ?
    `).get(p.payment_hash) as { settled_at: number } | undefined;

    if (settled) {
      // Resolve counterparty if not already set
      let counterparty = p.counterparty_pubkey;
      if (!counterparty) {
        if (!isTreasury && ENV.treasuryPubkey) {
          // Member node: all received payments come through the treasury
          counterparty = ENV.treasuryPubkey;
        }
        // Treasury: could try to match from payments_forwarded, but the
        // payment_hash won't match forwarded records directly (forwarded
        // payments use different hashes). Leave null for treasury receives.
      }

      db.prepare(`
        UPDATE network_payments
        SET status = 'succeeded', settled_at = ?, counterparty_pubkey = COALESCE(?, counterparty_pubkey)
        WHERE id = ?
      `).run(settled.settled_at || now, counterparty, p.id);
      updated++;
    }
  }

  // Backfill: on member nodes, set counterparty for any succeeded receives missing it
  if (!isTreasury && ENV.treasuryPubkey) {
    const backfilled = db.prepare(`
      UPDATE network_payments
      SET counterparty_pubkey = ?
      WHERE direction = 'receive' AND status = 'succeeded'
        AND (counterparty_pubkey IS NULL OR counterparty_pubkey = '')
    `).run(ENV.treasuryPubkey);
    if (backfilled.changes > 0) {
      console.log(`[network-payments] backfilled counterparty on ${backfilled.changes} received payment(s)`);
    }
  }

  return { updated };
}
