// One-off smoke test for the BASE sync loop's read path end-to-end.
//
// Uses the real singleton db (a temporary disk file via DB_DIR), runs
// all migrations to populate the schema, then calls fetchContractInfo()
// against a running `wrangler dev` Worker that proxies to live Base
// Sepolia. Persists the response into base_contract_state_cache as proof
// of end-to-end wiring.
//
// Run manually (not part of the regular test suite):
//   COINBASE_WORKER_URL=http://localhost:8787 \
//     DB_DIR=/tmp/smoke-test-db \
//     tsx scripts/smoke-test-base-sync.ts

import fs from "fs";
import { runMigrations } from "../src/db/migrate";
import { db } from "../src/db";
import { fetchContractInfo } from "../src/base/workerClient";
import { upsertContractState, getContractState } from "../src/base/store";

async function main() {
    if (!process.env.COINBASE_WORKER_URL) {
        console.error("[smoke] COINBASE_WORKER_URL not set");
        process.exit(1);
    }
    if (!process.env.DB_DIR) {
        console.error("[smoke] DB_DIR not set — refusing to write to default /data/db");
        process.exit(1);
    }
    console.log(`[smoke] worker = ${process.env.COINBASE_WORKER_URL}`);
    console.log(`[smoke] db_dir = ${process.env.DB_DIR}`);

    // Run all migrations against the singleton db so subscription_local_token
    // (used by workerFetch to look up a cached Bearer) exists.
    runMigrations();
    console.log("[smoke] migrations applied");

    const info = await fetchContractInfo();
    console.log("[smoke] /base/contract-info response:");
    console.log(JSON.stringify(info, null, 2));

    if (info.rpc_status !== "ok") {
        console.error(`[smoke] FAIL — expected rpc_status=ok, got ${info.rpc_status}`);
        process.exit(1);
    }

    upsertContractState({
        settlementRouterAddress: info.settlement_router_address!,
        currentFeeBps: info.current_fee_bps!,
        isPaused: info.is_paused!,
        feeRecipientAddress: "0x0000000000000000000000000000000000000000",
        asOfBlockNumber: info.as_of_block_number!,
        asOfAt: Date.now(),
    });
    const cached = getContractState();
    console.log("\n[smoke] persisted to base_contract_state_cache:");
    console.log(JSON.stringify(
        {
            settlementRouterAddress: cached?.settlementRouterAddress,
            currentFeeBps: cached?.currentFeeBps,
            isPaused: cached?.isPaused,
            asOfBlockNumber: cached?.asOfBlockNumber,
            ageMs: cached ? Date.now() - cached.asOfAt : null,
        },
        null,
        2,
    ));

    db.close();
    console.log("\n[smoke] PASS — sync read path works end-to-end against live Sepolia.");
}

main().catch((err) => {
    console.error("[smoke] FAIL:", err);
    process.exit(1);
});
