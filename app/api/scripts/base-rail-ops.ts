// Ops helper for operating the stablecoin rail locally before §8 ships the UI.
//
// Three commands:
//
//   tsx scripts/base-rail-ops.ts register <member_pubkey> <wallet_address>
//     Insert (or reactivate) a BASE wallet for a member in member_base_wallet.
//     Mirrors what the §8.1 registration UI will do.
//
//   tsx scripts/base-rail-ops.ts tick
//     Manually invoke one runOneTick() pass without waiting for the 60s
//     interval. Prints the structured tick result.
//
//   tsx scripts/base-rail-ops.ts inspect
//     Dump the current state of the rail's SQLite tables: wallets,
//     contract state cache, balance cache, settlement event count + last 5
//     rows, and the sync cursor.
//
// Runs against whatever DB_DIR/COINBASE_WORKER_URL the env exposes. Run
// from app/api/ with the same env loader as the API itself:
//
//   dotenv -e ../../.env.dev.treasury -- tsx scripts/base-rail-ops.ts <cmd> [args]

import { db } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import {
    listActiveBaseWallets,
    upsertMemberBaseWallet,
    getContractState,
    getUsdcBalance,
    getSyncCursor,
    countSettlementEvents,
} from "../src/base/store";
import { runOneTick } from "../src/base/sync";

function ensureSchema() {
    runMigrations();
}

function help() {
    console.log("Usage:");
    console.log("  tsx scripts/base-rail-ops.ts register <member_pubkey> <wallet_address>");
    console.log("  tsx scripts/base-rail-ops.ts tick");
    console.log("  tsx scripts/base-rail-ops.ts inspect");
    process.exit(1);
}

async function cmdRegister(memberPubkey: string, walletAddress: string) {
    ensureSchema();
    if (!/^[0-9a-f]{66}$/i.test(memberPubkey)) {
        console.error(`[ops] member_pubkey must be 66-char hex; got "${memberPubkey}"`);
        process.exit(1);
    }
    if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
        console.error(`[ops] wallet_address must be 0x + 40 hex chars; got "${walletAddress}"`);
        process.exit(1);
    }
    upsertMemberBaseWallet(memberPubkey.toLowerCase(), walletAddress.toLowerCase(), Date.now());
    const wallets = listActiveBaseWallets();
    console.log(`[ops] registered. Active wallets now: ${wallets.length}`);
    for (const w of wallets) {
        console.log(`  - pubkey ${w.memberPubkey.slice(0, 16)}... → ${w.walletAddress}`);
    }
}

async function cmdTick() {
    ensureSchema();
    console.log("[ops] running one sync tick...");
    const result = await runOneTick();
    console.log("[ops] tick result:");
    console.log(JSON.stringify(result, null, 2));
}

function cmdInspect() {
    ensureSchema();
    console.log("─── Sync cursor ─────────────────────────────────────");
    const cursor = getSyncCursor();
    console.log(`  lastSyncedBlockNumber: ${cursor.lastSyncedBlockNumber}`);
    console.log(`  lastSyncedAt:          ${new Date(cursor.lastSyncedAt).toISOString()} (${cursor.lastSyncedAt}ms)`);

    console.log("\n─── Active BASE wallets ─────────────────────────────");
    const wallets = listActiveBaseWallets();
    if (wallets.length === 0) console.log("  (none registered)");
    for (const w of wallets) {
        const bal = getUsdcBalance(w.walletAddress);
        const human = bal ? Number(bal.balanceUnits) / 1e6 : null;
        console.log(`  ${w.memberPubkey.slice(0, 16)}... → ${w.walletAddress}`);
        console.log(`    balance: ${bal ? `${human} USDC (as of block ${bal.asOfBlockNumber})` : "(uncached)"}`);
    }

    console.log("\n─── Contract state cache ────────────────────────────");
    const state = getContractState();
    if (!state) console.log("  (no row — sync loop hasn't completed step 1+2 yet)");
    else {
        console.log(`  router:        ${state.settlementRouterAddress}`);
        console.log(`  fee_bps:       ${state.currentFeeBps}`);
        console.log(`  paused:        ${state.isPaused}`);
        console.log(`  fee_recipient: ${state.feeRecipientAddress}`);
        console.log(`  as_of_block:   ${state.asOfBlockNumber}`);
        console.log(`  as_of_at:      ${new Date(state.asOfAt).toISOString()}`);
    }

    console.log("\n─── Settlement events ───────────────────────────────");
    const total = countSettlementEvents();
    console.log(`  total rows: ${total}`);
    if (total > 0) {
        const rows = db
            .prepare(
                `SELECT block_number, tx_hash, sender_address, recipient_address,
                        amount_units, fee_units, trade_ref, settled_at
                 FROM base_settlement_event ORDER BY block_number DESC, log_index DESC LIMIT 5`,
            )
            .all() as Array<{
                block_number: number;
                tx_hash: string;
                sender_address: string;
                recipient_address: string;
                amount_units: string;
                fee_units: string;
                trade_ref: string;
                settled_at: number;
            }>;
        console.log(`  last ${rows.length} (newest first):`);
        for (const r of rows) {
            console.log(`    block ${r.block_number}  tx ${r.tx_hash.slice(0, 12)}...  ` +
                `${r.sender_address.slice(0, 8)}... → ${r.recipient_address.slice(0, 8)}...  ` +
                `amount=${Number(r.amount_units) / 1e6} USDC  fee=${Number(r.fee_units) / 1e6}`);
        }
    }
}

const [cmd, ...args] = process.argv.slice(2);
(async () => {
    try {
        switch (cmd) {
            case "register":
                if (args.length !== 2) help();
                await cmdRegister(args[0], args[1]);
                break;
            case "tick":
                await cmdTick();
                break;
            case "inspect":
                cmdInspect();
                break;
            default:
                help();
        }
        db.close();
    } catch (err) {
        console.error("[ops] FAIL:", err);
        process.exit(1);
    }
})();
