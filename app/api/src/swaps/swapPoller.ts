// Swap poller — periodically matches in-flight swap_executions to Loop provider states.
// Runs on a 15s interval, matching the existing sync loop pattern.

import { db } from "../db";
import { listLoopSwaps, type SwapInfo } from "../lightning/loop";
import { normalizeLoopState, recordSwapEvent } from "./loopProvider";
import { getBtcUsd } from "../price/btcUsdCache";

/**
 * Mark expired quotes as expired. Called alongside status polling.
 * Prevents stale quote_created records from accumulating.
 */
function cleanupExpiredQuotes(): void {
  const now = Date.now();
  const expired = db.prepare(`
    UPDATE swap_requests
    SET status = 'expired', updated_at = ?, failure_reason = 'Quote expired'
    WHERE status = 'quote_created'
      AND quote_expires_at IS NOT NULL
      AND quote_expires_at < ?
  `).run(now, now);

  if (expired.changes > 0) {
    console.log(`[swap-poller] expired ${expired.changes} stale quote(s)`);
  }
}

/**
 * Poll Loop for status updates on in-flight swaps.
 * Called every 15s from index.ts alongside the LND sync loop.
 */
export async function pollSwapStatuses(): Promise<void> {
  cleanupExpiredQuotes();

  // Find non-terminal executions
  const inflight = db.prepare(`
    SELECT se.*, sr.status AS request_status, sr.id AS req_id
    FROM swap_executions se
    JOIN swap_requests sr ON se.swap_request_id = sr.id
    WHERE se.status NOT IN ('completed', 'failed')
      AND se.provider_swap_id IS NOT NULL
  `).all() as Array<{
    id: string;
    swap_request_id: string;
    provider_swap_id: string;
    status: string;
    req_id: string;
    request_status: string;
  }>;

  if (inflight.length === 0) return;

  let swaps: SwapInfo[];
  try {
    swaps = await listLoopSwaps();
  } catch (err: any) {
    console.warn("[swap-poller] Failed to list Loop swaps:", err.message);
    return;
  }

  const swapMap = new Map(swaps.map((s) => [s.id, s]));
  const now = Date.now();

  for (const exec of inflight) {
    const loopSwap = swapMap.get(exec.provider_swap_id);
    if (!loopSwap) continue;

    const newAppStatus = normalizeLoopState(loopSwap.state);
    const oldStatus = exec.status;

    if (newAppStatus === oldStatus) continue;

    // Update execution
    db.prepare(`
      UPDATE swap_executions
      SET status = ?, raw_provider_status = ?, completed_at = ?
      WHERE id = ?
    `).run(
      newAppStatus,
      loopSwap.state,
      newAppStatus === "completed" || newAppStatus === "failed" ? now : null,
      exec.id
    );

    // Update request
    const actualFee = newAppStatus === "completed"
      ? loopSwap.cost_server + loopSwap.cost_onchain + loopSwap.cost_offchain
      : null;

    if (actualFee !== null) {
      // Drive-mode P3 (R40(5)): the fee in dollars as of completion, stored
      // only when the rate is fresh (R18(9)); otherwise NULL, and the record
      // shows sats.
      const rate = getBtcUsd(now);
      const feeUsdCents = rate.state === "fresh" && rate.usd != null
        ? Math.round((actualFee / 100_000_000) * rate.usd * 100)
        : null;
      db.prepare("UPDATE swap_requests SET status = ?, actual_fee_sat = ?, actual_fee_usd_cents = ?, updated_at = ? WHERE id = ?")
        .run(newAppStatus, actualFee, feeUsdCents, now, exec.swap_request_id);
    } else if (newAppStatus === "failed") {
      db.prepare("UPDATE swap_requests SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        // loopd's raw failure code (drive-mode P1 item 9; the member-facing
        // sentences are P2's, R18(12)); the state only when loopd gives none.
        .run("failed", loopSwap.failure_reason ?? `Loop state: ${loopSwap.state}`, now, exec.swap_request_id);
    } else {
      db.prepare("UPDATE swap_requests SET status = ?, updated_at = ? WHERE id = ?")
        .run(newAppStatus, now, exec.swap_request_id);
    }

    recordSwapEvent(exec.swap_request_id, "provider_update", {
      old_status: oldStatus,
      new_status: newAppStatus,
      loop_state: loopSwap.state,
      cost_server: loopSwap.cost_server,
      cost_onchain: loopSwap.cost_onchain,
      cost_offchain: loopSwap.cost_offchain,
    }, exec.id);

    console.log(`[swap-poller] ${exec.swap_request_id}: ${oldStatus} → ${newAppStatus} (loop: ${loopSwap.state})`);
  }
}

/** Start the swap poller on a 15s interval. */
/** How long a row may sit in 'initiating' before the startup sweep treats it
 *  as interrupted. */
const INTERRUPTED_AFTER_MS = 10 * 60_000;

/**
 * Ruling e: mark rows left 'initiating' for more than 10 minutes as TERMINAL —
 * failed, failure_reason 'interrupted'. 'initiating' is set only by
 * initiateSwap's atomic claim and always left again by a running process, so a
 * row still there after 10 minutes was orphaned by a crash or restart
 * mid-initiation.
 *
 * ⚠ NEVER RELEASED back to an executable state: loopd may already have started
 * the swap before the process died, and releasing would let the same quote be
 * executed again. ⚠ A swap loopd started in that window is NOT TRACKED by
 * Bitcorn: no swap_executions row was written, so the poller cannot match it.
 * It still runs in loopd and is visible there (`loop listswaps`).
 *
 * Runs once at startup, from startSwapPoller.
 */
export function sweepInterruptedInitiations(now = Date.now()): void {
  const rows = db.prepare(`
    SELECT id FROM swap_requests WHERE status = 'initiating' AND updated_at < ?
  `).all(now - INTERRUPTED_AFTER_MS) as Array<{ id: string }>;
  for (const { id } of rows) {
    const r = db.prepare(`
      UPDATE swap_requests SET status = 'failed', failure_reason = 'interrupted', updated_at = ?
      WHERE id = ? AND status = 'initiating'
    `).run(now, id);
    if (r.changes === 1) {
      recordSwapEvent(id, "status_changed", { new_status: "failed", failure_reason: "interrupted" });
    }
  }
  if (rows.length > 0) {
    console.warn(
      `[swap-poller] marked ${rows.length} interrupted initiation(s) failed; ` +
        "a swap loopd started in that window is not tracked by Bitcorn"
    );
  }
}

export function startSwapPoller(): void {
  sweepInterruptedInitiations();
  setInterval(() => {
    pollSwapStatuses().catch((err) =>
      console.warn("[swap-poller] tick error:", err.message)
    );
  }, 15_000);
  console.log("[swap-poller] started (15s interval)");
}
