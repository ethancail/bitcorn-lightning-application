// End-to-end smoke for the events consumer (PR #200).
//
// Boots a real disk SQLite via DB_DIR, runs all migrations, registers
// the deployer wallet as a member, signs an ephemeral JWT and seeds it
// directly into subscription_local_token so workerFetch can attach it,
// points COINBASE_WORKER_URL at wrangler dev (which proxies to live
// Base Sepolia), runs ONE tick of the sync loop, and verifies
// base_settlement_event contains the PR #198 smoke transaction's
// Settled event.
//
// Run from app/api with:
//   COINBASE_WORKER_URL=http://localhost:8787 \
//     DB_DIR=/tmp/events-consumer-smoke-db \
//     TEST_SUBSCRIPTION_PRIVKEY_B64=$PRIV \
//     TEST_SUBSCRIPTION_PUBKEY_B64=$PUB \
//     tsx scripts/smoke-test-events-consumer.ts

import { SignJWT, importJWK } from "jose";
import { runMigrations } from "../src/db/migrate";
import { db } from "../src/db";
import {
    upsertMemberBaseWallet,
    countSettlementEvents,
    getSyncCursor,
} from "../src/base/store";
import { runOneTick } from "../src/base/sync";

const DEPLOYER = "0x4842925CF6B6671e8e1A25892bdeA0807b4814fD";
const FAKE_MEMBER_PUBKEY = "02" + "ab".repeat(32);
const EXPECTED_TRADE_REF = "0xf3f9467ab985f6fdff87a5fa4bb6ff265fd303b413dc334748d2e1236384f155";

function cacheTestToken(jwt: string, memberPubkey: string, expiresAtMs: number): void {
    const now = Date.now();
    db.prepare(`
        INSERT INTO subscription_local_token
            (id, member_pubkey, jwt, scope, issued_at, expires_at, fetched_at, updated_at)
        VALUES (1, ?, ?, 'payment', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            member_pubkey = excluded.member_pubkey,
            jwt = excluded.jwt,
            scope = excluded.scope,
            issued_at = excluded.issued_at,
            expires_at = excluded.expires_at,
            fetched_at = excluded.fetched_at,
            updated_at = excluded.updated_at
    `).run(memberPubkey, jwt, now, expiresAtMs, now, now);
}

async function main() {
    for (const v of ["COINBASE_WORKER_URL", "DB_DIR", "TEST_SUBSCRIPTION_PRIVKEY_B64", "TEST_SUBSCRIPTION_PUBKEY_B64"]) {
        if (!process.env[v]) {
            console.error("[smoke] " + v + " not set");
            process.exit(1);
        }
    }
    console.log("[smoke] worker = " + process.env.COINBASE_WORKER_URL);
    console.log("[smoke] db_dir = " + process.env.DB_DIR);

    runMigrations();
    console.log("[smoke] migrations applied");

    const privKey = await importJWK(
        {
            kty: "OKP",
            crv: "Ed25519",
            d: process.env.TEST_SUBSCRIPTION_PRIVKEY_B64!,
            x: process.env.TEST_SUBSCRIPTION_PUBKEY_B64!,
        },
        "EdDSA",
    );
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ scope: "payment" })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer("bitcorn-treasury")
        .setSubject(FAKE_MEMBER_PUBKEY)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privKey);
    cacheTestToken(jwt, FAKE_MEMBER_PUBKEY, (now + 600) * 1000);
    console.log("[smoke] cached test JWT");

    upsertMemberBaseWallet(FAKE_MEMBER_PUBKEY, DEPLOYER, Date.now());
    console.log("[smoke] registered " + DEPLOYER + " as test member");

    console.log("[smoke] running ONE tick (cold-start from deploy block)...");
    const result = await runOneTick();
    console.log("[smoke] tick result:");
    console.log(JSON.stringify({
        wallets_attempted: result.wallets_attempted,
        wallets_succeeded: result.wallets_succeeded,
        contract_state_synced: result.contract_state_synced,
        events_processed: result.events_processed,
        events_already_indexed: result.events_already_indexed,
        decode_errors_count: result.decode_errors_count,
        event_chunks_attempted: result.event_chunks_attempted,
        cursor_advanced_to: result.cursor_advanced_to,
        errors: result.errors,
    }, null, 2));

    const cursor = getSyncCursor();
    console.log("[smoke] cursor now at block " + cursor.lastSyncedBlockNumber);
    if (cursor.lastSyncedBlockNumber < 41_851_567) {
        console.error("[smoke] FAIL — cursor did not advance past smoke-tx block 41_851_567");
        process.exit(1);
    }

    const count = countSettlementEvents();
    console.log("[smoke] base_settlement_event row count: " + count);
    if (count < 1) {
        console.error("[smoke] FAIL — base_settlement_event is empty");
        process.exit(1);
    }

    const row = db
        .prepare("SELECT * FROM base_settlement_event WHERE trade_ref = ?")
        .get(EXPECTED_TRADE_REF) as any;
    if (!row) {
        console.error("[smoke] FAIL — expected smoke-tx Settled row not found");
        process.exit(1);
    }

    console.log("[smoke] smoke-tx Settled row:");
    console.log(JSON.stringify({
        block_number: row.block_number,
        tx_hash: row.tx_hash,
        sender: row.sender_address,
        recipient: row.recipient_address,
        amount_units: row.amount_units,
        fee_units: row.fee_units,
        trade_ref: row.trade_ref,
    }, null, 2));

    const checks = [
        ["block_number", row.block_number, 41_851_567],
        ["sender", row.sender_address.toLowerCase(), "0x4842925cf6b6671e8e1a25892bdea0807b4814fd"],
        ["recipient", row.recipient_address.toLowerCase(), "0xed503244e4e9bfd30315c9a022150c8302af817b"],
        ["amount", row.amount_units, "1000000"],
        ["fee", row.fee_units, "0"],
    ] as const;
    for (const [name, got, want] of checks) {
        if (got !== want) {
            console.error("[smoke] FAIL — " + name + ": got " + got + ", want " + want);
            process.exit(1);
        }
    }

    db.close();
    console.log("\n[smoke] PASS — events consumer end-to-end against live Sepolia.");
}

main().catch((err) => {
    console.error("[smoke] FAIL:", err);
    process.exit(1);
});
