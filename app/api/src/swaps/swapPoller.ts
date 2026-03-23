// Swap poller — periodically matches in-flight swap_executions to Loop provider states.
// Runs on a 15s interval, matching the existing sync loop pattern.

import { db } from "../db";
import { listLoopSwaps, type SwapInfo } from "../lightning/loop";
import { normalizeLoopState, recordSwapEvent } from "./loopProvider";

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
      db.prepare("UPDATE swap_requests SET status = ?, actual_fee_sat = ?, updated_at = ? WHERE id = ?")
        .run(newAppStatus, actualFee, now, exec.swap_request_id);
    } else if (newAppStatus === "failed") {
      db.prepare("UPDATE swap_requests SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        .run("failed", `Loop state: ${loopSwap.state}`, now, exec.swap_request_id);
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
export function startSwapPoller(): void {
  setInterval(() => {
    pollSwapStatuses().catch((err) =>
      console.warn("[swap-poller] tick error:", err.message)
    );
  }, 15_000);
  console.log("[swap-poller] started (15s interval)");
}
