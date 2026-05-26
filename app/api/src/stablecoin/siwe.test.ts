import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import { buildSiweMessage, newNonce, verifySiwe } from "./siwe";

// Pre-generated test keypair (do not use for any real wallet). The
// corresponding address is the EOA we'll sign and verify messages
// against in the test suite.
const TEST_PRIVATE_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_WALLET = account.address.toLowerCase();

const MEMBER_PUBKEY = "02" + "ab".repeat(32);
const DOMAIN = "treasury.example";
const CHAIN_ID = 84532;
const BASE_RPC_URL = ""; // empty → EOA fallback path inside verifySiwe

function buildAndSign(opts: {
    memberPubkey?: string;
    walletAddress?: string;
    domain?: string;
    chainId?: number;
    nonce?: string;
    issuedAtMs?: number;
    expiresAtMs?: number;
}) {
    const issuedAt = opts.issuedAtMs ?? Date.now();
    const expires = opts.expiresAtMs ?? issuedAt + 5 * 60_000;
    const nonce = opts.nonce ?? newNonce();
    const message = buildSiweMessage({
        memberPubkey: opts.memberPubkey ?? MEMBER_PUBKEY,
        walletAddress: opts.walletAddress ?? TEST_WALLET,
        domain: opts.domain ?? DOMAIN,
        chainId: opts.chainId ?? CHAIN_ID,
        nonce,
        issuedAtMs: issuedAt,
        expiresAtMs: expires,
    });
    return { message, nonce };
}

describe("buildSiweMessage", () => {
    it("constructs a well-formed EIP-4361 message with all expected fields", () => {
        const { message } = buildAndSign({});
        expect(message).toContain("wants you to sign in with your Ethereum account");
        expect(message).toContain("Bind this wallet to your Bitcorn membership.");
        expect(message).toContain("Version: 1");
        expect(message).toContain("Chain ID: 84532");
        expect(message).toContain("urn:bitcorn:member:" + MEMBER_PUBKEY);
    });
    it("uses EIP-55 checksum address (not lowercase)", () => {
        // Pick a known mixed-case address — viem's getAddress will canonicalize
        const lower = "0x4842925cf6b6671e8e1a25892bdea0807b4814fd";
        const { message } = buildAndSign({ walletAddress: lower });
        expect(message).toContain("0x4842925CF6B6671e8e1A25892bdeA0807b4814fD");
    });
    it("generates unique nonces across calls", () => {
        const a = newNonce();
        const b = newNonce();
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThanOrEqual(8);
    });
});

describe("verifySiwe — happy path (EOA wallet)", () => {
    it("accepts a correctly-signed message with matching expectations", async () => {
        const issuedAt = Date.now();
        const { message, nonce } = buildAndSign({ issuedAtMs: issuedAt });
        const signature = await account.signMessage({ message });

        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.walletAddress).toBe(TEST_WALLET);
            expect(outcome.memberPubkey).toBe(MEMBER_PUBKEY);
        }
    });
});

describe("verifySiwe — revert paths", () => {
    it("rejects on parse failure", async () => {
        const outcome = await verifySiwe({
            message: "not a SIWE message",
            signature: "0xdead" as `0x${string}`,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: "anynonce12345678",
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("parse_failed");
    });

    it("rejects when message.domain does not match expected", async () => {
        const { message, nonce } = buildAndSign({ domain: "other.example" });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("domain_mismatch");
    });

    it("rejects when message.chainId does not match expected", async () => {
        const { message, nonce } = buildAndSign({ chainId: 1 });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("chain_id_mismatch");
    });

    it("rejects when message.address does not match expected wallet", async () => {
        const { message, nonce } = buildAndSign({});
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: "0x0000000000000000000000000000000000000bad",
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("wallet_address_mismatch");
    });

    it("rejects when nonce does not match", async () => {
        const { message } = buildAndSign({ nonce: "originalnonce1234" });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: "differentnonce1234",
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("nonce_mismatch");
    });

    it("rejects when message is expired", async () => {
        const past = Date.now() - 60_000 * 10; // 10 min ago
        const { message, nonce } = buildAndSign({
            issuedAtMs: past,
            expiresAtMs: past + 60_000, // expired 9 min ago
        });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("expired");
    });

    it("rejects when member_pubkey URN is missing from resources", async () => {
        const { message, nonce } = buildAndSign({ memberPubkey: "02" + "cd".repeat(32) });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY, // the EXPECTED one — different from what's in message
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("member_pubkey_missing");
    });

    it("rejects on bad signature", async () => {
        const { message, nonce } = buildAndSign({});
        // Sign with a DIFFERENT key to produce a signature that won't recover
        // to the expected address.
        const otherAccount = privateKeyToAccount(generatePrivateKey());
        const badSignature = await otherAccount.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature: badSignature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("signature_invalid");
    });
});
