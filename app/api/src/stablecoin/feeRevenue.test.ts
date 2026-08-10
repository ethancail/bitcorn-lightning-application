import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const memDb = new Database(":memory:");
const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
for (const file of [
    "043_member_base_wallet.sql",
    "044_base_sync_cursor.sql",
    "045_base_usdc_balance_cache.sql",
    "046_base_settlement_event.sql",
    "047_base_contract_state_cache.sql",
    "053_base_sync_cursor_attempt_success.sql",
]) {
    memDb.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
}
vi.mock("../db", () => ({ db: memDb }));

import { vi } from "vitest";
const { buildRailFeeRevenue } = await import("./feeRevenue");
const { sumSettlementFees, upsertContractState } = await import("../base/store");

const NOW = 1_754_835_600_000;
const ROUTER = "0xf1bc89974f8520b7f98e7cf0c689a7077af04c78";
const FEE_RECIPIENT = "0xc7a819847b3d2a4d48beb999709c6ff36bf362b7";
const SENDER = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";
const RECIPIENT = "0xed503244e4e9bfd30315c9a022150c8302af817b";

let seq = 0;
/** Insert one Settled row. amount/fee are USDC base-unit strings. */
function settlement(blockNumber: number, amountUnits: string, feeUnits: string) {
    seq += 1;
    memDb
        .prepare(
            `INSERT INTO base_settlement_event
             (block_number, tx_hash, log_index, sender_address, recipient_address,
              amount_units, fee_units, trade_ref, settled_at, discovered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            blockNumber,
            "0x" + seq.toString(16).padStart(64, "0"),
            0,
            SENDER,
            RECIPIENT,
            amountUnits,
            feeUnits,
            "0x" + seq.toString(16).padStart(64, "1"),
            NOW,
            NOW,
        );
}

function setCursor(block: number, lastSuccessAt: number) {
    memDb
        .prepare(
            `UPDATE base_sync_cursor
             SET last_synced_block_number = ?, last_success_at = ?, last_attempt_at = ?
             WHERE id = 1`,
        )
        .run(block, lastSuccessAt, lastSuccessAt);
}

beforeEach(() => {
    memDb.exec("DELETE FROM base_settlement_event");
    memDb.exec("DELETE FROM base_contract_state_cache");
    setCursor(0, 0);
    seq = 0;
});

describe("sumSettlementFees — exact in base units", () => {
    it("SUB-CENT FEES SURVIVE THE SUM — the truncation trap", () => {
        // At the launch fee of 25 bps every settlement under $4 has a sub-cent
        // fee. formatUsdcUnits truncates to 2dp, so 9999 units ($0.009999)
        // formats to "0.00". Format-then-add would score all 200 of these as
        // zero; add-then-format keeps them.
        //
        // 200 x 9999 units = 1_999_800 units = $1.9998 -> "1.99".
        for (let i = 0; i < 200; i++) settlement(1000 + i, "4000000", "9999");

        const totals = sumSettlementFees();
        expect(totals.feeUnits).toBe(1_999_800n);
        expect(totals.settlementCount).toBe(200);

        setCursor(1_200, NOW - 1_000);
        const payload = buildRailFeeRevenue(NOW);
        // The whole point: NOT "0.00".
        expect(payload.all_time.fee_units_raw).toBe("1999800");
        expect(payload.all_time.fee_human).toBe("1.99");
    });

    it("is exact past 2^53 — where a float SUM would silently drift", () => {
        // Two values whose true sum exceeds Number.MAX_SAFE_INTEGER. This is the
        // case the JS-not-SQL comment in store.ts exists for: SQLite's SUM()
        // over a TEXT column coerces to REAL and loses the low bits with no
        // error of any kind.
        settlement(1, "9007199254740993", "9007199254740993");
        settlement(2, "9007199254740993", "9007199254740993");

        const totals = sumSettlementFees();
        expect(totals.feeUnits).toBe(18_014_398_509_481_986n);
        // Proof the value is beyond float-exact range, so the assertion above
        // is actually testing something.
        expect(Number(totals.feeUnits) > Number.MAX_SAFE_INTEGER).toBe(true);
        expect(totals.feeUnits.toString()).not.toBe(String(Number(totals.feeUnits)));
    });

    it("windows by block_number, inclusive of the from-block", () => {
        settlement(1_000, "1000000", "2500");
        settlement(50_000, "1000000", "2500");
        expect(sumSettlementFees(50_000).settlementCount).toBe(1);
        expect(sumSettlementFees(1_000).settlementCount).toBe(2);
    });
});

describe("buildRailFeeRevenue — the number never travels without its confidence", () => {
    it("a NEVER-SYNCED node reports never_synced with a zeroed window", () => {
        // The live treasury's state right now: PR #258 let it index, but it has
        // not ticked yet. The zero here is not a fact and the label says so.
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.freshness.staleness_label).toBe("never_synced");
        expect(payload.freshness.last_success_at).toBe(0);
        expect(payload.all_time.fee_units_raw).toBe("0");
        expect(payload.all_time.settlement_count).toBe(0);
        // Window collapses to [0, 0] rather than going negative.
        expect(payload.last_24h.from_block).toBe(0);
        expect(payload.last_24h.to_block).toBe(0);
    });

    it("a FRESH cursor with no settlements reports a stated zero", () => {
        setCursor(49_793_776, NOW - 41_000);
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.freshness.staleness_label).toBe("fresh");
        expect(payload.all_time.fee_units_raw).toBe("0");
        expect(payload.all_time.settlement_count).toBe(0);
    });

    it("a STALE cursor is reported as such even with real numbers", () => {
        settlement(49_790_000, "1000000", "2500");
        setCursor(49_793_776, NOW - 10 * 60 * 1000);
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.freshness.staleness_label).toBe("stale");
        expect(payload.all_time.fee_units_raw).toBe("2500");
    });

    it("EVERY response carries the freshness block — the client cannot opt out", () => {
        // Structural: if a future edit drops these fields, the panel's
        // can't-tell state becomes unreachable and it starts stating zeros it
        // has no basis for.
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.freshness).toBeDefined();
        expect(typeof payload.freshness.last_success_at).toBe("number");
        expect(typeof payload.freshness.staleness_label).toBe("string");
        expect(typeof payload.freshness.last_synced_block_number).toBe("number");
    });

    it("the 24h window is block-keyed at 43,200 blocks below the cursor", () => {
        setCursor(49_793_776, NOW - 1_000);
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.last_24h.to_block).toBe(49_793_776);
        expect(payload.last_24h.from_block).toBe(49_793_776 - 43_200);
    });

    it("the window EXCLUDES settlements older than the block range", () => {
        setCursor(49_793_776, NOW - 1_000);
        settlement(49_793_000, "1000000", "2500");           // inside
        settlement(49_793_776 - 43_201, "1000000", "9999");  // one block too old
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.last_24h.fee_units_raw).toBe("2500");
        expect(payload.all_time.fee_units_raw).toBe("12499"); // both counted
    });

    it("anchors the window on the CURSOR, not the chain tip", () => {
        // A node 3 days behind still reports its most recent indexed 24h rather
        // than an empty window — and the freshness label is what tells the
        // reader that 24h is itself 3 days old.
        setCursor(40_000_000, NOW - 3 * 24 * 3600 * 1000);
        settlement(39_999_000, "1000000", "2500");
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.last_24h.to_block).toBe(40_000_000);
        expect(payload.last_24h.fee_units_raw).toBe("2500");
        expect(payload.freshness.staleness_label).toBe("very_stale");
    });

    it("echoes the CURRENT fee recipient, or null when unknown", () => {
        expect(buildRailFeeRevenue(NOW).fee_recipient_address).toBeNull();
        upsertContractState({
            settlementRouterAddress: ROUTER,
            currentFeeBps: 25,
            isPaused: false,
            feeRecipientAddress: FEE_RECIPIENT,
            asOfBlockNumber: 49_793_776,
            asOfAt: NOW,
        });
        expect(buildRailFeeRevenue(NOW).fee_recipient_address).toBe(FEE_RECIPIENT);
    });

    it("labels the basis 'delivered', not 'accrued'", () => {
        // Verified against SettlementRouter._settle: the fee safeTransferFrom
        // precedes `emit Settled`, SafeERC20 reverts on failure, and a revert
        // rolls back the whole call — so a Settled event proves the fee landed.
        // Sweeps are still untracked, which is why this is cumulative delivery
        // and not a balance.
        expect(buildRailFeeRevenue(NOW).basis).toBe("delivered");
    });

    it("counts zero-fee settlements as settlements, distinguishing them from none", () => {
        // feeBps can be 0 (it is at launch). Five zero-fee settlements and zero
        // settlements both sum to 0 fees; settlement_count is what tells them
        // apart, and they are different facts about the rail.
        setCursor(49_793_776, NOW - 1_000);
        for (let i = 0; i < 5; i++) settlement(49_790_000 + i, "1000000", "0");
        const payload = buildRailFeeRevenue(NOW);
        expect(payload.all_time.fee_units_raw).toBe("0");
        expect(payload.all_time.settlement_count).toBe(5);
        expect(payload.all_time.gross_units_raw).toBe("5000000");
    });
});
