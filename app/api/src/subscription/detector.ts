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
// `getUtxos` is the ONLY source of which outputs exist, their amounts and
// their addresses — not `getChainTransactions`, because chain-transactions
// returns net per-tx amounts, not per-output, which can't disambiguate when
// one tx pays two members. UTXOs give per-output amounts cleanly.
// `getChainTransactions` IS used, but only as a txid → (confirming block,
// height) lookup for each candidate (confirmationTime.ts). A confirmation
// time is a property of a transaction, not an output, and no amount or
// attribution is read from that call, so the per-output problem does not
// return.
//
// Every credit computes from the deposit output's CONFIRMATION TIME (the
// confirming block's header nTime), never the wall clock — recredit-check,
// bitcorn-research specs/2026-11-13-recredit-check-credit-from-confirmation-
// time-spec.md. With a member's outputs folded in ascending confirmation
// height, a DB restore that replays still-unspent outputs reproduces the
// original paid_through exactly (spec §5). Once a UTXO is later swept by an admin
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
import { isInSubscriptionScope } from "./lanePurpose";
import { recomputeAllTiers } from "./tierDispatch";
import { resolveConfirmationTimes, type ConfirmationTime } from "./confirmationTime";
import {
  setUncreditedSnapshot,
  type UncreditedCause,
  type UncreditedEntry,
} from "./creditWaitAlert";

export interface ScanSummary {
  skipped_reason?: "first_run_not_acknowledged" | "lnd_unavailable" | "scan_in_flight";
  new_members_allocated: number;
  utxos_scanned: number;
  credits_written: number;
  pending_attribution_written: number;
  tier_transitions: number;
  errors: Array<{ context: string; error: string }>;
}

const ZERO_SUMMARY: Omit<ScanSummary, "skipped_reason"> = {
  new_members_allocated: 0,
  utxos_scanned: 0,
  credits_written: 0,
  pending_attribution_written: 0,
  tier_transitions: 0,
  errors: [],
};

/**
 * Runs the subscription deposit-scan step. Designed to be called from
 * the same setInterval callback that drives `syncLndState()`, after
 * that function resolves so chain state is fresh.
 *
 * Never throws — errors are collected in `summary.errors` so a single
 * bad UTXO doesn't kill the whole pass. The caller is expected to
 * `.catch()` on the promise as a final safety net. ⚠ Both callers
 * (index.ts) discard the summary, so anything that must be VISIBLE is
 * logged directly (warnUncredited) and surfaced as a treasury alert
 * (creditWaitAlert.ts), not only pushed into `summary.errors`.
 *
 * ⚠ IN-FLIGHT GUARD. The 15 s tick can outlast its period (callDeadline.ts
 * header), so a tick that finds the previous scan still running is skipped.
 * Within a scan, every confirmation-time lookup completes before any write,
 * and each member's paid_through is read and written with no await between.
 */
let scanInFlight = false;

export async function scanSubscriptionDeposits(): Promise<ScanSummary> {
  if (!isFirstRunAcknowledged()) {
    return { ...ZERO_SUMMARY, skipped_reason: "first_run_not_acknowledged" };
  }
  if (scanInFlight) {
    return { ...ZERO_SUMMARY, skipped_reason: "scan_in_flight" };
  }
  scanInFlight = true;
  try {
    return await runScan();
  } finally {
    scanInFlight = false;
  }
}

/** Skip warnings: at the first skip, then at most once an hour per outpoint. */
const UNCREDITED_WARN_INTERVAL_MS = 60 * 60 * 1000;
const uncreditedWarnLog = new Map<string, { firstSeenMs: number; lastWarnMs: number }>();

function warnUncredited(
  outpoint: string,
  memberPubkey: string,
  cause: "time_unavailable" | "credit_threw",
  detail: string,
  confirmations: number,
  heldCount: number,
): void {
  const now = Date.now();
  const seen = uncreditedWarnLog.get(outpoint);
  if (seen && now - seen.lastWarnMs < UNCREDITED_WARN_INTERVAL_MS) return;
  const firstSeenMs = seen?.firstSeenMs ?? now;
  uncreditedWarnLog.set(outpoint, { firstSeenMs, lastWarnMs: now });
  const what = cause === "time_unavailable" ? "its confirmation time is unavailable" : "its credit threw";
  const waitedMin = Math.round((now - firstSeenMs) / 60_000);
  console.warn(
    `[subscription] payment ${outpoint} for ${memberPubkey.slice(0, 16)}… not credited this scan: ${what}: ${detail}. ` +
      `Waiting ${waitedMin} min since first skipped; ${confirmations} confirmation(s).` +
      (heldCount > 0 ? ` Holding ${heldCount} other output(s) of this member behind it.` : "") +
      " Retried every scan.",
  );
}

type Utxo = Awaited<ReturnType<typeof getLndUtxos>>["utxos"][number];

const outpointOf = (u: Utxo) => `${u.transaction_id}:${u.transaction_vout}`;

/** Spec §5 step 4: height ascending, then txid (bytewise, lowercase hex), then vout. */
function compareForCredit(
  a: { u: Utxo; height: number },
  b: { u: Utxo; height: number },
): number {
  if (a.height !== b.height) return a.height - b.height;
  const ta = a.u.transaction_id.toLowerCase();
  const tb = b.u.transaction_id.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.u.transaction_vout - b.u.transaction_vout;
}

async function runScan(): Promise<ScanSummary> {
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

  // Step 4: the candidates — confirmed, at a deposit address, in neither
  // table. getUtxos order is never relied on.
  const policy = getSubscriptionPolicy();
  const deposits = utxos.filter(
    (u) => (u.confirmation_count ?? 0) >= 1 && addressToMember.has(u.address),
  );
  const candidates = deposits.filter(
    (u) => !alreadyRecorded(u.transaction_id, u.transaction_vout),
  );

  // Step 5: every confirmation-time lookup for the tick, before any write.
  // A tick with no candidate makes no extra LND call.
  const times: Map<string, ConfirmationTime> =
    candidates.length > 0
      ? await resolveConfirmationTimes(
          candidates.map((u) => ({ txid: u.transaction_id, confirmation_count: u.confirmation_count })),
        )
      : new Map();

  // Step 6: per member, in member_pubkey order; within a member, ascending
  // confirmation height (spec §5). Any failure stops that member for the tick.
  const left = new Map<string, { cause: UncreditedCause; detail: string | null; held_behind: string | null }>();
  const byMember = new Map<string, Utxo[]>();
  for (const u of candidates) {
    const member = addressToMember.get(u.address)!;
    const list = byMember.get(member) ?? [];
    list.push(u);
    byMember.set(member, list);
  }

  for (const memberPubkey of [...byMember.keys()].sort()) {
    const outputs = byMember.get(memberPubkey)!;

    // ⚠ An output with no time has no place in the order (its height may be
    // unknown too), so ANY untimed output holds ALL of the member's
    // candidates this tick. Crediting the others could fold out of order,
    // which a later replay would not reproduce (spec §5, proof condition 1).
    const untimed = outputs
      .filter((u) => !times.get(u.transaction_id)?.ok)
      .sort((a, b) => (outpointOf(a) < outpointOf(b) ? -1 : 1));
    if (untimed.length > 0) {
      const root = outpointOf(untimed[0]);
      for (const u of untimed) {
        const t = times.get(u.transaction_id);
        const detail = t && !t.ok ? t.cause : "no confirmation-time lookup result";
        left.set(outpointOf(u), { cause: "time_unavailable", detail, held_behind: null });
        summary.errors.push({ context: `utxo ${outpointOf(u)}`, error: `confirmation time unavailable: ${detail}` });
        warnUncredited(
          outpointOf(u),
          memberPubkey,
          "time_unavailable",
          detail,
          u.confirmation_count,
          outpointOf(u) === root ? outputs.length - untimed.length : 0,
        );
      }
      for (const u of outputs) {
        if (!left.has(outpointOf(u))) {
          left.set(outpointOf(u), { cause: "held_behind", detail: null, held_behind: root });
        }
      }
      continue;
    }

    const ordered = outputs
      .map((u) => {
        const t = times.get(u.transaction_id) as Extract<ConfirmationTime, { ok: true }>;
        return { u, height: t.height, timeMs: t.timeMs };
      })
      .sort(compareForCredit);

    for (let i = 0; i < ordered.length; i++) {
      const { u, timeMs } = ordered[i];
      try {
        const result = await processConfirmedUtxo(u, memberPubkey, policy, timeMs);
        if (result === "credited") summary.credits_written++;
        else if (result === "pending") summary.pending_attribution_written++;
      } catch (err: any) {
        const detail = err?.message ?? String(err);
        const rest = ordered.slice(i + 1);
        left.set(outpointOf(u), { cause: "credit_threw", detail, held_behind: null });
        for (const r of rest) {
          left.set(outpointOf(r.u), { cause: "held_behind", detail: null, held_behind: outpointOf(u) });
        }
        summary.errors.push({ context: `utxo ${outpointOf(u)}`, error: detail });
        warnUncredited(outpointOf(u), memberPubkey, "credit_threw", detail, u.confirmation_count, rest.length);
        break;
      }
    }
  }

  // Step 6b: the alert's snapshot (creditWaitAlert.ts), after the last
  // credit. Cause-agnostic: every deposit output still in neither table is an
  // entry — the test is re-run here, not reused from step 4.
  const entries: UncreditedEntry[] = [];
  for (const u of deposits) {
    if (alreadyRecorded(u.transaction_id, u.transaction_vout)) continue;
    const why = left.get(outpointOf(u));
    entries.push({
      outpoint: outpointOf(u),
      member_pubkey: addressToMember.get(u.address)!,
      confirmations: u.confirmation_count,
      cause: why?.cause ?? "unknown",
      detail: why?.detail ?? null,
      held_behind: why?.held_behind ?? null,
    });
  }
  setUncreditedSnapshot({ as_of: Date.now(), entries });
  for (const outpoint of [...uncreditedWarnLog.keys()]) {
    const why = left.get(outpoint);
    if (!why || why.cause === "held_behind") uncreditedWarnLog.delete(outpoint);
  }

  // Step 5: recompute current_tier for every subscription row per §5.
  // Cheap (single SELECT + per-row UPDATE-on-change) and runs every
  // tick so the API surfaces fresh tier values immediately after any
  // credit + paid_through advance.
  try {
    const tiers = recomputeAllTiers(policy);
    summary.tier_transitions = tiers.transitions.length;
    for (const t of tiers.transitions) {
      console.log(
        `[subscription] tier transition ${t.from} → ${t.to} for ${t.member_pubkey.slice(0, 16)}…`,
      );
    }
  } catch (err: any) {
    summary.errors.push({
      context: "recomputeAllTiers",
      error: err?.message ?? String(err),
    });
  }

  return summary;
}

/**
 * Finds peers that have channels with the treasury, are in subscription
 * scope (merchant_lane or farmer_lane), and don't have a `subscription`
 * row yet — and allocates them in `prepay` mode. Returns the count of
 * newly-allocated subscriptions.
 *
 * Lane-purpose filter is applied per-peer (not in SQL) because the
 * classifier reads contacts.tags + the curated external-pubkey list,
 * which would be awkward to encode at the query layer. The cost is
 * one classifier call per uncontacted peer per tick — bounded by
 * cluster size, negligible.
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
    if (!isInSubscriptionScope(peer_pubkey)) continue;
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

/**
 * Writes one output's ledger row (or pending row) and advances paid_through.
 *
 * `confirmedAtMs` is the output's confirmation time (T_conf). It is the time
 * basis of the credit (computeNewPaidThrough's creditTimeMs) and is stored in
 * `confirmed_at` and `last_payment_at` (ruling O4 (c) with (c1)); no
 * migration — the column already exists in both tables. `received_at` stays
 * the DETECTION time, so a replayed row shows the replay moment in
 * received_at beside its original confirmed_at.
 */
async function processConfirmedUtxo(
  utxo: { transaction_id: string; transaction_vout: number; tokens: number },
  memberPubkey: string,
  policy: ReturnType<typeof getSubscriptionPolicy>,
  confirmedAtMs: number,
): Promise<"credited" | "pending"> {
  const outcome = attributePayment(utxo.tokens, policy);
  const detectedAt = Date.now();

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
      detectedAt,
      confirmedAtMs,
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

  // ⚠ NO AWAIT BETWEEN HERE AND writeCredit() BELOW. The paid_through read,
  // the computation and the write must be one synchronous run, so nothing
  // can interleave a credit for the same member between them.
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
    confirmedAtMs,
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
      detectedAt,
      confirmedAtMs,
      outcome.period_extension_days,
    );
    // last_payment_at keeps the later of the stored value and this T_conf, so
    // the rescan residual (spec §5 (1)) cannot move it backwards; the txid
    // moves only with it, so the pair stays coherent. SQLite evaluates every
    // SET expression against the row as it was before this UPDATE.
    db.prepare(
      `UPDATE subscription
       SET last_payment_txid = CASE WHEN last_payment_at IS NULL OR last_payment_at <= ? THEN ? ELSE last_payment_txid END,
           last_payment_at   = CASE WHEN last_payment_at IS NULL OR last_payment_at <= ? THEN ? ELSE last_payment_at END,
           paid_through = ?
       WHERE member_pubkey = ?`,
    ).run(
      confirmedAtMs,
      utxo.transaction_id,
      confirmedAtMs,
      confirmedAtMs,
      newPaidThrough,
      memberPubkey,
    );
  });
  writeCredit();
  return "credited";
}
