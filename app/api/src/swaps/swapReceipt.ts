/**
 * A completed swap's fee receipt (drive-mode P2 item 14; spec D2.6): the
 * summary and the three parts behind it, server-derived with NO migration.
 *
 * The parts are loopd's own costs, which the poller already stores in each
 * `provider_update` event (swapPoller.ts): cost_server (the swap service's
 * fee), cost_onchain (the Bitcoin network fee) and cost_offchain (Lightning
 * routing). The poller sets actual_fee_sat to their sum at completion, so the
 * receipt's total is that same sum, read from the same event.
 *
 * Read-only. Null unless the swap completed AND a completed provider_update
 * carries the costs: a row from before the poller wrote them has a fee and no
 * parts, and a receipt whose parts did not sum to its total would be worse
 * than none.
 */

export interface SwapReceipt {
  total_sat: number;
  /** cost_server — the swap service's fee (paid to the Loop server). */
  swap_fee_sat: number;
  /** cost_onchain — the Bitcoin network fee. */
  network_fee_sat: number;
  /** cost_offchain — Lightning routing. */
  routing_fee_sat: number;
}

export function receiptFor(
  swap: { status: string },
  events: Array<{ event_type: string; event_json: string }>,
): SwapReceipt | null {
  if (swap.status !== "completed") return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "provider_update") continue;
    let data: any;
    try {
      data = JSON.parse(e.event_json);
    } catch {
      continue;
    }
    if (data?.new_status !== "completed") continue;
    const parts = [data.cost_server, data.cost_onchain, data.cost_offchain];
    if (!parts.every((p) => typeof p === "number" && Number.isFinite(p))) return null;
    const [swap_fee_sat, network_fee_sat, routing_fee_sat] = parts as number[];
    return { total_sat: swap_fee_sat + network_fee_sat + routing_fee_sat, swap_fee_sat, network_fee_sat, routing_fee_sat };
  }
  return null;
}
