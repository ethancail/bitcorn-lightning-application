// Sync-loop step that watches subscription deposit addresses for
// incoming on-chain payments and writes credits to the ledger.
//
// Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §4
//
// Mechanism: ln-service `getUtxos` returns LND's view of all unspent
// outputs with per-output address, amount, and confirmation count.
// We filter to (address ∈ subscription deposit set, conf ≥ 1, (txid,
// vout) not yet recorded), attribute each new UTXO to its member,
// classify it (credit vs pending-attribution), and write the ledger
// rows.
//
// `getUtxos` is preferred over `getChainTransactions` here because
// chain-transactions returns net per-tx amounts, not per-output —
// which can't disambiguate when one tx pays two members. UTXOs give
// per-output amounts cleanly. Once a UTXO is later swept by an admin
// action, it disappears from `getUtxos`, but by then the credit row
// is durable in `subscription_payment`. The 15-second sync cadence
// vs weeks-apart manual sweeps makes the race window negligible.
//
// Also handles per-tick member discovery: any peer present in
// `lnd_channels` but missing from `subscription` is allocated a fresh
// `prepay` subscription row before the deposit-scan runs. Backfill
// (grandfathered) handles the flip-day population; this handles
// new members that appeared after.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLndUtxos } from "../lightning/lnd";
import { isFirstRunAcknowledged } from "./firstRunGate";
import { getSubscriptionPolicy } from "./policy";
import { allocateSubscriptionForMember } from "./addressAllocator";
import { attributePayment, computeNewPaidThrough } from "./paymentMath";
import { fetchBtcUsdSpotCents, satsToUsdCents } from "./btcUsdSpot";

export interface ScanSummary {
  skipped_reason?: "first_run_not_acknowledged" | "lnd_unavailable";
  new_members_allocated: number;
  utxos_scanned: number;
  credits_written: number;
  pending_attribution_written: number;
  errors: Array<{ context: string; error: string }>;
}

const ZERO_SUMMARY: Omit<ScanSummary, "skipped_reason"> = {
  new_members_allocated: 0,
  utxos_scanned: 0,
  credits_written: 0,
  pending_attribution_written: 0,
  errors: [],
};

/**
 * Runs the subscription deposit-scan step. Designed to be called from
 * the same setInterval callback that drives `syncLndState()`, after
 * that function resolves so chain state is fresh.
 *
 * Never throws — errors are collected in `summary.errors` so a single
 * bad UTXO doesn't kill the whole pass. The caller is expected to
 * `.catch()` on the promise as a final safety net.
 */
export async function scanSubscriptionDeposits(): Promise<ScanSummary> {
  if (!isFirstRunAcknowledged()) {
    return { ...ZERO_SUMMARY, skipped_reason: "first_run_not_acknowledged" };
  }

  const summary: ScanSummary = { ...ZERO_SUMMARY };

  // Step 1: discover new members (peers with channels that don't yet
  // have a subscription row) and allocate them in `prepay` mode.
  try {
    summary.new_members_allocated = await discoverAndAllocateNewMembers();
  } catch (err: any) {
    summary.errors.push({
      context: "discover_new_members",
      error: err?.message ?? String(err),
    });
  }

  // Step 2: pull current UTXO set from LND. Confirmation filter
  // applied client-side because we want to count even unconfirmed
  // UTXOs in `utxos_scanned` for observability.
  let utxos: Awaited<ReturnType<typeof getLndUtxos>>["utxos"];
  try {
    ({ utxos } = await getLndUtxos());
  } catch (err: any) {
    summary.errors.push({
      context: "getLndUtxos",
      error: err?.message ?? String(err),
    });
    return summary;
  }
  summary.utxos_scanned = utxos.length;

  // Step 3: build the (deposit_address → member_pubkey) lookup once.
  const addressToMember = new Map<string, string>();
  const addressRows = db
    .prepare("SELECT deposit_address, member_pubkey FROM subscription")
    .all() as Array<{ deposit_address: string; member_pubkey: string }>;
  for (const row of addressRows) {
    addressToMember.set(row.deposit_address, row.member_pubkey);
  }

  // Step 4: process each candidate UTXO.
  const policy = getSubscriptionPolicy();
  for (const utxo of utxos) {
    if ((utxo.confirmation_count ?? 0) < 1) continue;
    const memberPubkey = addressToMember.get(utxo.address);
    if (!memberPubkey) continue;

    if (alreadyRecorded(utxo.transaction_id, utxo.transaction_vout)) continue;

    try {
      const result = await processConfirmedUtxo(utxo, memberPubkey, policy);
      if (result === "credited") summary.credits_written++;
      else if (result === "pending") summary.pending_attribution_written++;
    } catch (err: any) {
      summary.errors.push({
        context: `utxo ${utxo.transaction_id}:${utxo.transaction_vout}`,
        error: err?.message ?? String(err),
      });
    }
  }

  return summary;
}

/**
 * Finds peers that have channels with the treasury but don't have a
 * `subscription` row yet, and allocates them in `prepay` mode. Returns
 * the count of newly-allocated subscriptions.
 */
async function discoverAndAllocateNewMembers(): Promise<number> {
  const treasuryPubkey = ENV.treasuryPubkey ?? "";
  const peers = db
    .prepare(
      `SELECT DISTINCT c.peer_pubkey
       FROM lnd_channels c
       LEFT JOIN subscription s ON s.member_pubkey = c.peer_pubkey
       WHERE c.peer_pubkey != ?
         AND s.member_pubkey IS NULL`,
    )
    .all(treasuryPubkey) as Array<{ peer_pubkey: string }>;

  let allocated = 0;
  for (const { peer_pubkey } of peers) {
    try {
      await allocateSubscriptionForMember(peer_pubkey, "fresh");
      allocated++;
    } catch {
      // Allocator can fail on first-run-not-acknowledged or LND issues;
      // this isn't a hard error per UTXO, surface via outer summary.
    }
  }
  return allocated;
}

function alreadyRecorded(txid: string, vout: number): boolean {
  // Check both the credit ledger and the pending bucket — a UTXO
  // already parked in either should not be re-evaluated.
  const inLedger = db
    .prepare(
      "SELECT 1 FROM subscription_payment WHERE txid = ? AND vout = ?",
    )
    .get(txid, vout);
  if (inLedger) return true;
  const inPending = db
    .prepare(
      "SELECT 1 FROM subscription_pending_attribution WHERE txid = ? AND vout = ?",
    )
    .get(txid, vout);
  return Boolean(inPending);
}

async function processConfirmedUtxo(
  utxo: { transaction_id: string; transaction_vout: number; tokens: number },
  memberPubkey: string,
  policy: ReturnType<typeof getSubscriptionPolicy>,
): Promise<"credited" | "pending"> {
  const outcome = attributePayment(utxo.tokens, policy);
  const now = Date.now();

  if (outcome.kind === "pending_attribution") {
    db.prepare(
      `INSERT INTO subscription_pending_attribution (
          txid, vout, amount_sats, member_pubkey,
          received_at, confirmed_at, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      utxo.transaction_id,
      utxo.transaction_vout,
      utxo.tokens,
      memberPubkey,
      now,
      now,
      outcome.reason,
    );
    return "pending";
  }

  // Best-effort BTC/USD read, outside the DB transaction so a slow
  // Coinbase response doesn't hold the SQLite lock. The column stores
  // the USD-cents value of THIS payment (sats × spot ÷ 100M), not the
  // BTC/USD spot rate itself — see satsToUsdCents.
  const spotCentsPerBtc = await fetchBtcUsdSpotCents();
  const usdCentsOfPayment = satsToUsdCents(utxo.tokens, spotCentsPerBtc);
  if (spotCentsPerBtc == null) {
    console.warn(
      `[subscription] BTC/USD lookup failed for credit ${utxo.transaction_id}:${utxo.transaction_vout}`,
    );
  }

  const member = db
    .prepare(
      "SELECT paid_through FROM subscription WHERE member_pubkey = ?",
    )
    .get(memberPubkey) as { paid_through: number } | undefined;
  if (!member) {
    throw new Error(
      `Member row vanished mid-scan: ${memberPubkey}`,
    );
  }

  const newPaidThrough = computeNewPaidThrough(
    member.paid_through,
    outcome.period_extension_days,
    now,
  );

  const writeCredit = db.transaction(() => {
    db.prepare(
      `INSERT INTO subscription_payment (
          member_pubkey, txid, vout, amount_sats,
          amount_usd_cents_at_receipt,
          received_at, confirmed_at,
          period_extension_days, kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'onchain')`,
    ).run(
      memberPubkey,
      utxo.transaction_id,
      utxo.transaction_vout,
      utxo.tokens,
      usdCentsOfPayment,
      now,
      now,
      outcome.period_extension_days,
    );
    db.prepare(
      `UPDATE subscription
       SET last_payment_txid = ?, last_payment_at = ?, paid_through = ?
       WHERE member_pubkey = ?`,
    ).run(utxo.transaction_id, now, newPaidThrough, memberPubkey);
  });
  writeCredit();
  return "credited";
}
