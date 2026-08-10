// Treasury-only rail fee-revenue aggregate.
//
// Serves GET /api/admin/rail/fee-revenue. Treasury-gated at the route
// (assertTreasury), on the same pattern as GET /api/admin/subscription/revenue.
//
// ─── WHY THIS LIVES ON THE TREASURY AND NOT UNDER /api/stablecoin/* ───────
//
// The /api/stablecoin/* block is deliberately NOT role-gated (index.ts, "Member
// identity is the local node's pubkey via getNodeInfo(); same trust model as
// the subscription endpoints"). Putting a treasury-only route in there would
// break that stated model, so this one sits under /api/admin/ where the
// role gate already belongs.
//
// ─── WHAT THE NUMBER IS, EXACTLY ─────────────────────────────────────────
//
// TOTAL FEES CHARGED BY THE ROUTER, and — verified against the contract, not
// assumed — fees that were DELIVERED, not merely accrued:
//
//   SettlementRouter._settle() performs `safeTransferFrom(sender, feeRecipient,
//   fee)` and only THEN `emit Settled(...)`. SafeERC20 reverts on a failed
//   transfer, and EVM atomicity means a revert rolls back the whole call — so
//   no Settled event is ever emitted for a settlement whose fee transfer
//   failed. A Settled event with fee > 0 therefore PROVES the fee reached
//   whatever address was `feeRecipient` in that block. (When feeBps is 0 the
//   contract skips the transfer entirely under `if (fee > 0)`, so the
//   implication holds vacuously: no fee, nothing to deliver.)
//
// The earlier framing of this figure as "accrued, not realized" was WRONG and
// is corrected here. What survives of that caveat is narrower and still real:
//
//   1. SWEEPS ARE NOT TRACKED. This is cumulative delivery, not a balance. The
//      recipient's current holdings are lower by whatever has been swept out,
//      and higher by any unrelated deposit. Reading balanceOf() would be the
//      wrong number for both reasons — see the 2026-08-04 fee-recipient
//      decision, which is why this reads transfer history instead.
//
//   2. ATTRIBUTION IS TO THE ROUTER, NOT TO AN ADDRESS. `setFeeRecipient` is
//      onlyOwner and can move where fees go. base_settlement_event has no
//      per-event recipient column, so a historical fee cannot be attributed to
//      the address that received it — only to the router that charged it. The
//      moment the recipient is changed (the 2026-08-04 decision records a flip
//      condition for a second multisig), all_time will span two destinations.
//      Hence the deliberate wording: fees CHARGED BY THE ROUTER.
//
//      Fixing that needs FeeRecipientUpdated ingestion, which needs a Worker
//      EVENT_ALLOWLIST entry (it currently allows only Settled, FeeBpsUpdated,
//      Paused, Unpaused) plus a table plus a join. Out of scope here; the
//      response is worded so it does not claim what it cannot know.
//
// `fee_recipient_address` in the response is the CURRENT recipient, from the
// contract-state cache. It answers "where do fees go now?", NOT "where did
// these fees go?" — do not let a future edit imply otherwise.

import type { IncomingMessage, ServerResponse } from "http";
import { getContractState, getSyncCursor, sumSettlementFees } from "../base/store";
import { classifyRailStaleness, railStalenessSeconds } from "./staleness";
import { formatUsdcUnits } from "./handlers";
import type { RailFeeRevenueResponse, RailFeeTotals } from "./types";

const JSON_CT = { "Content-Type": "application/json" };

const USDC_DECIMALS = 6;

/**
 * Blocks in a 24h window on Base.
 *
 * MEASURED, not assumed (2026-08-10, Base mainnet): the timestamp delta across
 * exactly 43,200 blocks was exactly 86,400 s — 2.0000 s/block — and six
 * 1,000-block samples spanning that range were each exactly 2,000 s. Base is an
 * OP Stack chain with a fixed 2 s slot; empty blocks are produced when there is
 * no demand, so the rate does not vary with traffic.
 *
 * The one thing that breaks it is a sequencer outage, and it breaks in a single
 * direction: if blocks stop for D, then (anchor - 43200) reaches back 24h + D,
 * so the window OVER-covers and the figure over-states. It cannot under-report.
 *
 * The sound fix is real block timestamps, which /base/events does not return
 * (see the note in base/sync.ts on settled_at). Until then the mitigation is
 * disclosure rather than cleverness: from_block/to_block ship in the response
 * so a reader can always see what was actually counted, and the UI says "~24h".
 */
const BLOCKS_PER_24H = 43_200;

function toTotals(t: { feeUnits: bigint; grossUnits: bigint; settlementCount: number }): RailFeeTotals {
    return {
        // Raw base units are the contract; the *_human strings are a courtesy.
        fee_units_raw: t.feeUnits.toString(),
        gross_units_raw: t.grossUnits.toString(),
        // THE ONLY TRUNCATION POINT. Summing happened in BigInt (store.ts,
        // sumSettlementFees); formatting happens once, here, on the total. Never
        // format per row and add — formatUsdcUnits truncates to 2dp, so at the
        // launch fee of 25 bps every settlement under $4 has a sub-cent fee that
        // would silently become 0.00 before it was ever added.
        fee_human: formatUsdcUnits(t.feeUnits, USDC_DECIMALS),
        gross_human: formatUsdcUnits(t.grossUnits, USDC_DECIMALS),
        settlement_count: t.settlementCount,
    };
}

/** Pure core, exported for tests: no req/res, no clock of its own. */
export function buildRailFeeRevenue(nowMs: number): RailFeeRevenueResponse {
    const cursor = getSyncCursor();
    const state = getContractState();

    // The 24h window is anchored on the CURSOR, not the chain tip. The data only
    // extends as far as we have indexed, so anchoring on the tip would silently
    // yield an empty window whenever sync lags. Anchored here, the window means
    // "the last ~24h of indexed data" — and how old THAT is, is exactly what the
    // freshness block below reports.
    const toBlock = cursor.lastSyncedBlockNumber;
    const fromBlock = Math.max(0, toBlock - BLOCKS_PER_24H);

    const allTime = sumSettlementFees();
    // A never-synced node has toBlock 0, so the window is [0, 0] and the query
    // matches nothing — correct, and the never_synced label is what stops the
    // client rendering that as a meaningful zero.
    const window = sumSettlementFees(fromBlock);

    return {
        all_time: toTotals(allTime),
        last_24h: { ...toTotals(window), from_block: fromBlock, to_block: toBlock },
        // ⚠ SHIPS IN THE SAME PAYLOAD ON PURPOSE. SUM(fee) === 0 means
        // "genuinely zero" only when the cursor is fresh; under never_synced it
        // means "nothing was ever looked at". Returning the numbers without the
        // confidence would let a client render the second as the first, which is
        // the single worst thing this surface could do while the rail is quiet.
        freshness: {
            last_synced_block_number: cursor.lastSyncedBlockNumber,
            last_success_at: cursor.lastSuccessAt,
            staleness_seconds: railStalenessSeconds(cursor.lastSuccessAt, nowMs),
            staleness_label: classifyRailStaleness(cursor.lastSuccessAt, nowMs),
        },
        basis: "delivered",
        // CURRENT recipient only — see the header note on attribution.
        fee_recipient_address: state?.feeRecipientAddress ?? null,
        currency: "USDC",
        decimals: USDC_DECIMALS,
    };
}

// GET /api/admin/rail/fee-revenue
export function handleRailFeeRevenue(_req: IncomingMessage, res: ServerResponse): void {
    const payload = buildRailFeeRevenue(Date.now());
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(payload));
}
