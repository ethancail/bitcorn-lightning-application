import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { buildSiweMessage, newNonce, resolveSiweChain, siweRpcUrl, verifySiwe } from "./siwe";

// Pre-generated test keypair (do not use for any real wallet). The
// corresponding address is the EOA we'll sign and verify messages
// against in the test suite.
const TEST_PRIVATE_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_WALLET = account.address.toLowerCase();

const MEMBER_PUBKEY = "02" + "ab".repeat(32);
const DOMAIN = "treasury.example";
const CHAIN_ID = 84532;
// Empty = the stock member-node state: no operator-set endpoint. It NO LONGER
// means "no chain client" — verifySiwe now falls back to the chain's public RPC
// (siweRpcUrl), which is the whole point of that change. So these tests must
// control the transport themselves; see the fetch stub below.
const BASE_RPC_URL = "";

// ⚠ EVERY TEST IN THIS FILE STUBS fetch, AND MUST.
//
// Before the public-RPC fallback, an empty BASE_RPC_URL threw before any network
// call, so this suite was hermetic by accident. Now a client always builds, and
// viem's verifyMessage really would reach out — VERIFIED: without this stub these
// tests hit live https://sepolia.base.org (it answered eth_chainId 0x14a34 from
// the test host). A suite that silently depends on a public endpoint is one
// outage away from red, and one network policy away from slow.
//
// Default: reject, which reproduces "no usable chain read" — the condition the
// pre-existing tests were written against. Tests that need a working chain read
// override `rpcHandler`.
let rpcHandler: (body: string) => unknown;

beforeEach(() => {
    rpcHandler = () => {
        throw new Error("no network in tests (default stub)");
    };
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
        const result = rpcHandler(init?.body ?? "");
        return {
            ok: true,
            status: 200,
            json: async () => ({ jsonrpc: "2.0", id: 1, result }),
            text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
            headers: new Headers({ "content-type": "application/json" }),
        };
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

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

    // ─── No BASE RPC: EOA verdicts stand, smart wallets are not blamed ─────
    //
    // With BASE_RPC_URL empty (as above — the whole file runs that way) the
    // chain client cannot be built, so verification falls back to local EOA
    // recovery. Two outcomes have to stay separable, and conflating them fails
    // in both directions: reporting a real bad signature as a config problem
    // masks an authentication failure behind a 503, and reporting an
    // unverifiable smart-wallet signature as `signature_invalid` blames the
    // member for the operator's omission — on the DEFAULT wallet path, since
    // Coinbase Smart Wallet is listed first in the web app's connectors.
    //
    // What separates them is whether local recovery can produce a VERDICT, not
    // any inspection of the address (which would need the missing RPC):
    //   - well-formed 65-byte signature that doesn't match → recovery returns
    //     false → the verdict is real → signature_invalid (test above)
    //   - anything not 65 bytes → recovery THROWS ("invalid signature length",
    //     measured) → no verdict exists → smart_wallet_verification_unavailable
    // ─── The public-RPC fallback ────────────────────────────────────────────
    //
    // BASE_RPC_URL cannot ship in the image (it embeds an API key) and members
    // administer their own nodes, so on a stock node it is unset. Verification
    // therefore falls back to the chain's own public endpoint, taken from viem's
    // chain definition rather than a hardcoded string.
    describe("RPC fallback resolution", () => {
        it("falls back to the chain's public RPC when BASE_RPC_URL is unset", () => {
            expect(siweRpcUrl(base, "")).toBe(base.rpcUrls.default.http[0]);
            expect(siweRpcUrl(baseSepolia, "")).toBe(baseSepolia.rpcUrls.default.http[0]);
        });

        it("an operator-set endpoint always wins over the fallback", () => {
            const keyed = "https://base-mainnet.example/v2/SECRET";
            expect(siweRpcUrl(base, keyed)).toBe(keyed);
            expect(siweRpcUrl(baseSepolia, keyed)).toBe(keyed);
        });

        it("the fallback comes from viem, so it cannot drift from the library", () => {
            // Asserted against viem's own definition rather than a literal: if viem
            // changes Base's default endpoint, this tracks it instead of going stale.
            // (Values at time of writing: mainnet.base.org / sepolia.base.org.)
            expect(siweRpcUrl(base, "")).toMatch(/^https:\/\//);
            expect(siweRpcUrl(baseSepolia, "")).toMatch(/^https:\/\//);
        });

        it("resolves only the two supported BASE chains", () => {
            expect(resolveSiweChain(8453)).toBe(base);
            expect(resolveSiweChain(84532)).toBe(baseSepolia);
            expect(resolveSiweChain(1)).toBeUndefined();
        });
    });

    it("chain SIWE cannot verify against is its own reason, not a bad signature", async () => {
        // Operator misconfiguration (BASE_CHAIN_ID pointing off-Base) needs a
        // different fix from a network failure, so it must not share a reason code.
        const { message, nonce } = buildAndSign({ chainId: 1 });
        const signature = await account.signMessage({ message });
        const outcome = await verifySiwe({
            message,
            signature,
            expectedDomain: DOMAIN,
            expectedChainId: 1,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe("siwe_chain_unsupported");
    });

    it("NEGATIVE CONTROL: smart-wallet signature VERIFIES with BASE_RPC_URL unset", async () => {
        // This is the whole point of the fallback. Same inputs that previously
        // returned smart_wallet_verification_unavailable on a stock node — a
        // contract-shaped signature with no operator-set endpoint — must now reach
        // the chain and come back verified.
        //
        // The chain read is stubbed to answer "valid" so the test asserts OUR
        // plumbing (a client gets built against the public endpoint and its answer
        // is honoured), not Base's liveness.
        rpcHandler = () => `0x${"0".repeat(63)}1`; // ERC-1271/6492: true
        const { message, nonce } = buildAndSign({});
        const contractSignature = ("0x" + "ab".repeat(200)) as `0x${string}`;
        const outcome = await verifySiwe({
            message,
            signature: contractSignature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL, // "" — the stock member-node state
        });
        expect(outcome.ok).toBe(true);
    });

    it("no BASE RPC + non-EOA-shaped signature: reports config, not a bad signature", async () => {
        const { message, nonce } = buildAndSign({});
        // An ERC-1271/6492-style signature: ABI-encoded, so not the 65 bytes
        // local recovery can evaluate. Recovery throws rather than returning a
        // verdict, so blaming the signature would be a guess.
        const contractSignature = ("0x" + "ab".repeat(200)) as `0x${string}`;
        const outcome = await verifySiwe({
            message,
            signature: contractSignature,
            expectedDomain: DOMAIN,
            expectedChainId: CHAIN_ID,
            expectedMemberPubkey: MEMBER_PUBKEY,
            expectedWalletAddress: TEST_WALLET,
            expectedNonce: nonce,
            baseRpcUrl: BASE_RPC_URL,
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.reason).toBe("smart_wallet_verification_unavailable");
            // Not an auth failure — the caller must not be told their signature
            // was rejected when it was never evaluated.
            expect(outcome.reason).not.toBe("signature_invalid");
        }
    });
});
