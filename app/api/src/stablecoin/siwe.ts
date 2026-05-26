// SIWE (Sign-In With Ethereum / EIP-4361) message construction + verification
// for the BASE wallet registration flow.
//
// Spec amendment: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §2
//
// The amendment specifies the four properties the message must carry:
//   1. The member's Lightning pubkey
//   2. The connected wallet's address
//   3. The current treasury hostname / domain identifier
//   4. A fresh nonce from the API container
//   5. A timestamp (issuedAt)
//
// EIP-4361's canonical format carries items 2, 3, 4, 5 directly; item 1
// (the Lightning pubkey) is encoded as a Resources entry per EIP-4361's
// `Resources` field, which is a list of URIs. We use the URN scheme
// `urn:bitcorn:member:<66-char-hex>` to make the binding semantically
// explicit when the member reads the message in their wallet prompt.

import {
    createSiweMessage,
    generateSiweNonce,
    parseSiweMessage,
} from "viem/siwe";
import {
    createPublicClient,
    getAddress,
    http,
    verifyMessage as verifyMessageRpc,
    type Hex,
    type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";

export const NONCE_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes
export const STATEMENT = "Bind this wallet to your Bitcorn membership.";

export interface BuildMessageInput {
    /** Lightning pubkey of the member (66-char compressed hex). */
    memberPubkey: string;
    /** EVM wallet address being bound (0x-prefixed, 20 bytes). */
    walletAddress: string;
    /** Domain that issued the challenge — used as `domain` and `uri` in the message. */
    domain: string;
    /** Chain ID the wallet is expected to be on (84532 testnet, 8453 mainnet). */
    chainId: number;
    /** Server-issued nonce. */
    nonce: string;
    /** Unix ms timestamp the challenge was issued. */
    issuedAtMs: number;
    /** Unix ms timestamp the challenge expires (= issuedAt + NONCE_LIFETIME_MS). */
    expiresAtMs: number;
}

/**
 * Construct the SIWE message string the member's wallet will sign.
 *
 * The output is the canonical EIP-4361 format. Member's Lightning pubkey is
 * encoded as a Resources URN so the binding semantic is visible in the
 * wallet's prompt.
 */
export function buildSiweMessage(input: BuildMessageInput): string {
    return createSiweMessage({
        domain: input.domain,
        address: toChecksumAddress(input.walletAddress),
        statement: STATEMENT,
        uri: `https://${input.domain}`,
        version: "1",
        chainId: input.chainId,
        nonce: input.nonce,
        issuedAt: new Date(input.issuedAtMs),
        expirationTime: new Date(input.expiresAtMs),
        resources: [`urn:bitcorn:member:${input.memberPubkey.toLowerCase()}`],
    });
}

export type VerifyOutcome =
    | { ok: true; walletAddress: string; memberPubkey: string; nonce: string }
    | {
          ok: false;
          reason:
              | "parse_failed"
              | "signature_invalid"
              | "wallet_address_mismatch"
              | "member_pubkey_missing"
              | "nonce_mismatch"
              | "domain_mismatch"
              | "expired"
              | "chain_id_mismatch";
          detail?: string;
      };

export interface VerifyInput {
    /** The SIWE message verbatim as the wallet signed it. */
    message: string;
    /** Hex signature returned by the wallet. */
    signature: Hex;
    /** Domain the API issued the challenge under (must match message.domain). */
    expectedDomain: string;
    /** Chain ID the API expects (must match message.chainId). */
    expectedChainId: number;
    /**
     * The (member, wallet, nonce) tuple stored when the challenge was issued.
     * The verifier confirms the signed message echoed back the same nonce
     * and that its resources entry matches the stored member_pubkey.
     */
    expectedMemberPubkey: string;
    expectedWalletAddress: string;
    expectedNonce: string;
    /**
     * BASE RPC URL for verifying smart-wallet (ERC-1271 / ERC-6492) signatures
     * such as Coinbase Smart Wallet. Empty string disables smart-wallet
     * verification — caller still gets EOA verification via plain
     * verifyMessage. Production callers should always pass a URL.
     */
    baseRpcUrl: string;
}

/**
 * Verify a signed SIWE message against an issued challenge.
 *
 * Five checks, in order:
 *   1. Parse the message (well-formed EIP-4361)
 *   2. Signature recovers to message.address
 *   3. message.address matches the stored wallet_address
 *   4. message.nonce matches the stored nonce
 *   5. message.domain and chainId match what the API issued
 *   6. message.expirationTime > now
 *   7. The Lightning pubkey resource in the message matches the stored member_pubkey
 *
 * Any failure short-circuits to a structured `ok: false` with a `reason`
 * code the caller maps to an HTTP status / error body.
 */
export async function verifySiwe(input: VerifyInput): Promise<VerifyOutcome> {
    // 1. Parse
    let parsed: ReturnType<typeof parseSiweMessage>;
    try {
        parsed = parseSiweMessage(input.message);
    } catch (err) {
        return {
            ok: false,
            reason: "parse_failed",
            detail: err instanceof Error ? err.message : String(err),
        };
    }
    if (!parsed.address || !parsed.nonce || !parsed.chainId || !parsed.domain) {
        return { ok: false, reason: "parse_failed", detail: "missing required SIWE fields" };
    }

    // 2. Domain + chain consistency
    if (parsed.domain !== input.expectedDomain) {
        return {
            ok: false,
            reason: "domain_mismatch",
            detail: `message.domain="${parsed.domain}" expected "${input.expectedDomain}"`,
        };
    }
    if (parsed.chainId !== input.expectedChainId) {
        return {
            ok: false,
            reason: "chain_id_mismatch",
            detail: `message.chainId=${parsed.chainId} expected ${input.expectedChainId}`,
        };
    }

    // 3. Address echoes back what the API issued the challenge for
    if (parsed.address.toLowerCase() !== input.expectedWalletAddress.toLowerCase()) {
        return {
            ok: false,
            reason: "wallet_address_mismatch",
            detail: "signed message's address does not match the challenged address",
        };
    }

    // 4. Nonce echoes back what the API issued
    if (parsed.nonce !== input.expectedNonce) {
        return { ok: false, reason: "nonce_mismatch" };
    }

    // 5. Expiration in the future
    if (parsed.expirationTime && parsed.expirationTime.getTime() <= Date.now()) {
        return { ok: false, reason: "expired" };
    }

    // 6. Resources include the bound member pubkey URN
    const expectedResource =
        `urn:bitcorn:member:${input.expectedMemberPubkey.toLowerCase()}`;
    const resources = parsed.resources ?? [];
    if (!resources.includes(expectedResource)) {
        return {
            ok: false,
            reason: "member_pubkey_missing",
            detail:
                `expected resource "${expectedResource}" not in message.resources=` +
                JSON.stringify(resources),
        };
    }

    // 7. Signature verification (last because cryptographic — most expensive)
    // viem's verifySiweMessage requires a public client because Coinbase
    // Smart Wallet (the recommended wallet per spec amendment §1) is an
    // ERC-1271 smart contract account; verifying its signatures means
    // calling isValidSignature on-chain. For EOA wallets (MetaMask, etc.)
    // the client is still used but only for the ERC-6492 fallback path.
    let valid: boolean;
    try {
        const client = makePublicClient(input.baseRpcUrl, input.expectedChainId);
        valid = await client.verifyMessage({
            address: parsed.address as Hex,
            message: input.message,
            signature: input.signature,
        });
    } catch (err) {
        // Fall back to EOA-only recovery if the chain client isn't usable.
        // Preserves MetaMask flows during a brief BASE-RPC outage.
        try {
            valid = await verifyMessageRpc({
                address: parsed.address as Hex,
                message: input.message,
                signature: input.signature,
            });
        } catch {
            return {
                ok: false,
                reason: "signature_invalid",
                detail:
                    "could not verify signature; chain client and EOA fallback both failed: " +
                    (err instanceof Error ? err.message : String(err)),
            };
        }
    }
    if (!valid) {
        return { ok: false, reason: "signature_invalid" };
    }

    return {
        ok: true,
        walletAddress: parsed.address.toLowerCase(),
        memberPubkey: input.expectedMemberPubkey.toLowerCase(),
        nonce: parsed.nonce,
    };
}

/** Generate a fresh SIWE nonce. Delegates to viem's helper (alphanumeric, ≥ 8 chars). */
export function newNonce(): string {
    return generateSiweNonce();
}

// -----------------------------------------------------------------------
// EIP-55 checksum (used by SIWE — viem's createSiweMessage requires it)
// -----------------------------------------------------------------------

/**
 * Convert a lowercase address to EIP-55 checksum form for SIWE message
 * construction. Delegates to viem's `getAddress`.
 */
function toChecksumAddress(addr: string): Hex {
    return getAddress(addr);
}

/**
 * Build a viem public client for the configured BASE chain. Cached
 * per-(url, chainId) so we don't reinstantiate on every verification.
 */
const clientCache = new Map<string, PublicClient>();
function makePublicClient(rpcUrl: string, chainId: number): PublicClient {
    const key = `${chainId}:${rpcUrl}`;
    const cached = clientCache.get(key);
    if (cached) return cached;
    if (!rpcUrl) {
        throw new Error("BASE_RPC_URL is not configured; cannot verify smart-wallet signatures");
    }
    const chain = chainId === base.id ? base : chainId === baseSepolia.id ? baseSepolia : undefined;
    if (!chain) {
        throw new Error(
            `unsupported chainId for SIWE verification: ${chainId} (expected ${base.id} or ${baseSepolia.id})`,
        );
    }
    const client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
    clientCache.set(key, client);
    return client;
}
