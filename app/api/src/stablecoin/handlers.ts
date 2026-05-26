// HTTP handlers for the stablecoin rail's member-facing API surface.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §8
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md
//
// The handlers follow the raw-http convention from app/api/src/index.ts:
// each takes (req, res) and writes the response directly. The "member"
// identity is the local node's pubkey from getNodeInfo() — same trust
// model as the existing subscription endpoints (local-network-only via
// CORS).

import type { IncomingMessage, ServerResponse } from "http";
import type { Hex } from "viem";
import { db } from "../db";
import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import {
    getContractState,
    getSyncCursor,
    getUsdcBalance,
    listActiveBaseWallets,
    upsertMemberBaseWallet,
} from "../base/store";
import {
    NONCE_LIFETIME_MS,
    buildSiweMessage,
    newNonce,
    verifySiwe,
} from "./siwe";
import {
    consumeChallengeNonce,
    getChallengeNonce,
    upsertChallengeNonce,
} from "./nonceStore";
import { classifyRailStaleness, railStalenessSeconds } from "./staleness";
import type {
    BalanceResponse,
    ChallengeRequest,
    ChallengeResponse,
    ContractStateResponse,
    SettlementRow,
    SettlementsResponse,
    SyncCursorResponse,
    WalletRegisterRequest,
    WalletRegisterResponse,
    WalletStatusResponse,
} from "./types";

const JSON_CT = { "Content-Type": "application/json" };

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (!raw) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(raw) as T);
            } catch {
                resolve(null);
            }
        });
        req.on("error", () => resolve(null));
    });
}

function jsonError(res: ServerResponse, status: number, code: string, detail?: string): void {
    res.writeHead(status, JSON_CT);
    res.end(JSON.stringify({ error: code, detail: detail ?? code }));
}

function getLocalMemberPubkey(): string | null {
    const info = getNodeInfo();
    return info?.pubkey?.toLowerCase() ?? null;
}

function siweDomain(req: IncomingMessage): string {
    const host = req.headers.host ?? "localhost";
    return host;
}

function isLowercaseHexAddress(s: unknown): s is string {
    return typeof s === "string" && /^0x[0-9a-f]{40}$/.test(s);
}

function readChainId(): number {
    return 84532;
}

function formatUsdcUnits(units: bigint, decimals: number): string {
    if (decimals === 0) return units.toString();
    const divisor = 10n ** BigInt(decimals);
    const whole = units / divisor;
    const frac = units % divisor;
    if (frac === 0n) return whole.toString() + ".00";
    const fracStr = frac.toString().padStart(decimals, "0");
    const twoDecimals = fracStr.slice(0, 2);
    return whole.toString() + "." + twoDecimals;
}

// POST /api/stablecoin/wallet/challenge
export async function handleChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready", "local LND identity not available yet");

    const body = await readJsonBody<ChallengeRequest>(req);
    if (!body || typeof body.wallet_address !== "string") {
        return jsonError(res, 400, "invalid_body", "wallet_address (string) is required");
    }
    const walletAddress = body.wallet_address.toLowerCase();
    if (!isLowercaseHexAddress(walletAddress)) {
        return jsonError(res, 400, "invalid_wallet_address", "must be 0x + 40 hex chars");
    }

    const chainId = readChainId();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + NONCE_LIFETIME_MS;
    const nonce = newNonce();
    const message = buildSiweMessage({
        memberPubkey: member,
        walletAddress,
        domain: siweDomain(req),
        chainId,
        nonce,
        issuedAtMs: issuedAt,
        expiresAtMs: expiresAt,
    });

    upsertChallengeNonce(member, walletAddress, nonce, issuedAt, expiresAt);

    const response: ChallengeResponse = { message, nonce, expires_at: expiresAt };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// POST /api/stablecoin/wallet (submit signed SIWE)
export async function handleWalletRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready");

    const body = await readJsonBody<WalletRegisterRequest>(req);
    if (!body || typeof body.message !== "string" || typeof body.signature !== "string") {
        return jsonError(res, 400, "invalid_body", "message and signature (strings) are required");
    }

    const m = /(0x[0-9a-fA-F]{40})/.exec(body.message);
    if (!m) return jsonError(res, 400, "parse_failed", "could not extract address from message");
    const walletAddress = m[1].toLowerCase();

    const stored = getChallengeNonce(member, walletAddress);
    if (!stored) {
        return jsonError(
            res,
            400,
            "no_outstanding_challenge",
            "no outstanding SIWE challenge; request /wallet/challenge first",
        );
    }

    const outcome = await verifySiwe({
        message: body.message,
        signature: body.signature as Hex,
        expectedDomain: siweDomain(req),
        expectedChainId: readChainId(),
        expectedMemberPubkey: member,
        expectedWalletAddress: stored.walletAddress,
        expectedNonce: stored.nonce,
        baseRpcUrl: ENV.baseRpcUrl,
    });

    if (!outcome.ok) {
        const status = outcome.reason === "signature_invalid" ? 401 : 400;
        return jsonError(res, status, outcome.reason, outcome.detail);
    }

    consumeChallengeNonce(member, walletAddress);
    const registeredAt = Date.now();
    upsertMemberBaseWallet(member, walletAddress, registeredAt);

    const response: WalletRegisterResponse = {
        wallet_address: walletAddress,
        registered_at: registeredAt,
    };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// GET /api/stablecoin/wallet
export function handleWalletStatus(_req: IncomingMessage, res: ServerResponse): void {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready");
    const wallets = listActiveBaseWallets();
    const mine = wallets.find((w) => w.memberPubkey === member);
    const response: WalletStatusResponse = mine
        ? { wallet_address: mine.walletAddress, registered_at: mine.registeredAt, is_active: mine.isActive }
        : { wallet_address: null, registered_at: null, is_active: false };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// DELETE /api/stablecoin/wallet
export function handleWalletUnregister(_req: IncomingMessage, res: ServerResponse): void {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready");
    db.prepare("UPDATE member_base_wallet SET is_active = 0 WHERE member_pubkey = ?").run(member);
    res.writeHead(204);
    res.end();
}

// GET /api/stablecoin/balance
export function handleBalance(_req: IncomingMessage, res: ServerResponse): void {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready");
    const wallets = listActiveBaseWallets();
    const mine = wallets.find((w) => w.memberPubkey === member);
    if (!mine) return jsonError(res, 404, "no_wallet", "register a BASE wallet first");
    const row = getUsdcBalance(mine.walletAddress);
    if (!row) {
        return jsonError(
            res,
            404,
            "balance_not_cached_yet",
            "sync loop has not yet observed this wallet; try again in ~60s",
        );
    }
    const now = Date.now();
    const decimals = 6;
    const response: BalanceResponse = {
        wallet_address: row.walletAddress,
        balance_units_raw: row.balanceUnits.toString(),
        decimals,
        balance_human: formatUsdcUnits(row.balanceUnits, decimals),
        as_of_block_number: row.asOfBlockNumber,
        as_of_at: row.asOfAt,
        staleness_seconds: railStalenessSeconds(row.asOfAt, now),
        staleness_label: classifyRailStaleness(row.asOfAt, now),
    };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// GET /api/stablecoin/contract-state
export function handleContractState(_req: IncomingMessage, res: ServerResponse): void {
    const state = getContractState();
    if (!state) {
        return jsonError(
            res,
            404,
            "contract_state_not_cached_yet",
            "sync loop has not yet refreshed the contract state cache",
        );
    }
    const response: ContractStateResponse = {
        settlement_router_address: state.settlementRouterAddress,
        current_fee_bps: state.currentFeeBps,
        is_paused: state.isPaused,
        fee_recipient_address: state.feeRecipientAddress,
        as_of_block_number: state.asOfBlockNumber,
        as_of_at: state.asOfAt,
    };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// GET /api/stablecoin/sync-cursor
export function handleSyncCursor(_req: IncomingMessage, res: ServerResponse): void {
    const cursor = getSyncCursor();
    const now = Date.now();
    const response: SyncCursorResponse = {
        last_synced_block_number: cursor.lastSyncedBlockNumber,
        last_synced_at: cursor.lastSyncedAt,
        staleness_seconds: railStalenessSeconds(cursor.lastSyncedAt, now),
        staleness_label: classifyRailStaleness(cursor.lastSyncedAt, now),
    };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}

// GET /api/stablecoin/settlements
const SETTLEMENTS_PAGE_SIZE = 50;
const SETTLEMENTS_MAX_PAGE_SIZE = 200;

export function handleSettlements(req: IncomingMessage, res: ServerResponse): void {
    const member = getLocalMemberPubkey();
    if (!member) return jsonError(res, 503, "node_not_ready");
    const wallets = listActiveBaseWallets();
    const mine = wallets.find((w) => w.memberPubkey === member);
    if (!mine) {
        const response: SettlementsResponse = { settlements: [], next_before_block: null };
        res.writeHead(200, JSON_CT);
        res.end(JSON.stringify(response));
        return;
    }

    const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));
    const limit = Math.min(
        SETTLEMENTS_MAX_PAGE_SIZE,
        Number(url.searchParams.get("limit") ?? SETTLEMENTS_PAGE_SIZE),
    );
    const beforeBlock = url.searchParams.get("before_block");
    const cursorBlock = beforeBlock ? Number(beforeBlock) : Number.MAX_SAFE_INTEGER;

    const rows = db
        .prepare(
            "SELECT block_number, tx_hash, log_index, sender_address, recipient_address, " +
                "amount_units, fee_units, trade_ref, settled_at, discovered_at " +
                "FROM base_settlement_event " +
                "WHERE (sender_address = ? OR recipient_address = ?) " +
                "  AND block_number < ? " +
                "ORDER BY block_number DESC, log_index DESC " +
                "LIMIT ?",
        )
        .all(mine.walletAddress, mine.walletAddress, cursorBlock, limit + 1) as Array<{
            block_number: number;
            tx_hash: string;
            log_index: number;
            sender_address: string;
            recipient_address: string;
            amount_units: string;
            fee_units: string;
            trade_ref: string;
            settled_at: number;
            discovered_at: number;
        }>;

    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;

    const settlements: SettlementRow[] = visible.map((r) => ({
        block_number: r.block_number,
        tx_hash: r.tx_hash,
        log_index: r.log_index,
        sender_address: r.sender_address,
        recipient_address: r.recipient_address,
        amount_units_raw: r.amount_units,
        fee_units_raw: r.fee_units,
        amount_human: formatUsdcUnits(BigInt(r.amount_units), 6),
        fee_human: formatUsdcUnits(BigInt(r.fee_units), 6),
        trade_ref: r.trade_ref,
        settled_at: r.settled_at,
        discovered_at: r.discovered_at,
        direction: r.sender_address === mine.walletAddress ? "sent" : "received",
    }));

    const response: SettlementsResponse = {
        settlements,
        next_before_block: hasMore ? visible[visible.length - 1].block_number : null,
    };
    res.writeHead(200, JSON_CT);
    res.end(JSON.stringify(response));
}
