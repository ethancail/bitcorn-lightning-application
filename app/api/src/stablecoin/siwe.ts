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
              | "chain_id_mismatch"
              /**
               * This node cannot verify an ERC-1271 (smart contract account)
               * signature because it has no BASE RPC endpoint configured. NOT an
               * authentication failure — the signature was never evaluated.
               *
               * Distinct from `signature_invalid` on purpose. Coinbase Smart
               * Wallet is the DEFAULT connector (web wagmi.ts lists it first with
               * preference: "smartWalletOnly"), so before this existed the most
               * common wallet on the most common path produced a 401 telling the
               * member their signature was invalid — for an omission only the
               * node operator can fix, and with the accurate diagnostic
               * discarded.
               *
               * ⚠ ITS CAUSE CHANGED. It used to mean "BASE_RPC_URL is unset,"
               * which was a per-node configuration gap. Verification now falls
               * back to the chain's public RPC (see siweRpcUrl), so unset is no
               * longer a failure. What remains is: the chain read did not
               * complete — the endpoint was unreachable, rate-limited, or
               * erroring. Transient, not a setup problem, and the member-facing
               * copy in handlers.ts says so.
               */
              | "smart_wallet_verification_unavailable"
              /**
               * BASE_CHAIN_ID names a chain SIWE cannot verify against. Split out
               * from the above because the operator fix is different — correct the
               * chain id, not the RPC — and because it is permanent rather than
               * transient, so "try again" would be false advice.
               */
              | "siwe_chain_unsupported";
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
    // Chain first, as a named outcome. An unsupported chainId is an operator
    // misconfiguration (BASE_CHAIN_ID set to something that is not Base), and it
    // needs a different fix from "the network read failed" — so it must not share
    // a reason code with it. Previously it threw and was reported as the
    // smart-wallet-unavailable case, which pointed the operator at the wrong var.
    const chain = resolveSiweChain(input.expectedChainId);
    if (!chain) {
        return {
            ok: false,
            reason: "siwe_chain_unsupported",
            detail:
                `chainId ${input.expectedChainId} is not a supported BASE chain ` +
                `(expected ${base.id} or ${baseSepolia.id}) — check BASE_CHAIN_ID`,
        };
    }

    // Hoisted so the negative-path liveness probe below can reuse the same client
    // (and therefore the same endpoint) that produced the ambiguous result.
    //
    // ⚠ CONSTRUCTION MUST NOT THROW — it is outside the try, so anything thrown
    // here escapes verifySiwe instead of becoming an outcome. It cannot today: the
    // chain is already resolved above, siweRpcUrl cannot throw, and viem's
    // createPublicClient accepts even a malformed url (VERIFIED: "not-a-url",
    // "ftp://x" and "   " all construct; the failure surfaces at call time, which
    // IS inside the try). If you add a throwing step to makePublicClient, move the
    // call back inside the try and give the liveness probe its own client.
    const client = makePublicClient(chain, input.baseRpcUrl);
    let valid: boolean;
    try {
        valid = await client.verifyMessage({
            address: parsed.address as Hex,
            message: input.message,
            signature: input.signature,
        });
        if (!valid) {
            // ⚠ A `false` FROM viem IS AMBIGUOUS — and confirming liveness here is
            // what makes the public-RPC fallback safe to ship.
            //
            // MEASURED: verifyMessage SWALLOWS transport failures and returns false
            // rather than throwing (forced fetch rejection → `RETURNED: false`).
            // Now that a client ALWAYS builds — which is exactly what the fallback
            // guarantees — a bare false conflates two different things:
            //     the signature genuinely does not match
            //     the chain read failed, so nothing was checked
            //
            // Left unhandled, the fallback would have REINTRODUCED the mislabel
            // PR #246 removed, by a different route: an RPC outage telling the
            // member their signature was rejected when it was never evaluated. The
            // old code was right only by accident — an unset URL threw before any
            // read was attempted.
            //
            // getChainId throws on transport failure where verifyMessage does not
            // (both measured), so it disambiguates. Throwing here deliberately
            // routes into the catch below, which attempts LOCAL recovery — so a
            // 65-byte EOA signature still gets a definitive local verdict instead
            // of being written off as unverifiable. Costs one round-trip, and only
            // on the negative path; a successful verification never reaches it.
            await client.getChainId();
        }
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
            // ⚠ NOT `signature_invalid`. Reaching here means the on-chain read
            // FAILED AND local recovery could not evaluate the signature at all —
            // which is what an ERC-1271 smart-wallet signature does, because local
            // recovery throws on anything that is not a 65-byte secp256k1
            // signature (verified: "invalid signature length"). The signature was
            // never examined, so blaming it would be a guess.
            //
            // ⚠ THE CAUSE HERE IS NARROWER THAN IT USED TO BE. This was the
            // "BASE_RPC_URL is unset" path — a per-node configuration gap that hit
            // every stock member node. Verification now falls back to the chain's
            // public RPC (siweRpcUrl), so unset is no longer a failure, and an
            // unsupported chain id returns `siwe_chain_unsupported` before we get
            // here. What is left is a genuine chain-read failure: endpoint
            // unreachable, rate-limited, or erroring. Transient, so handlers.ts
            // now says "try again" rather than "this node is not set up."
            //
            // It originally reported `signature_invalid`, which told the member
            // their signature was rejected when it was never examined — on the
            // DEFAULT wallet path. handlers.ts maps this reason to 503 and keeps
            // configuration detail out of the response body.
            //
            // A genuinely bad EOA signature does NOT land here: local recovery
            // returns false for a well-formed 65-byte signature that doesn't
            // match, so it falls through to `signature_invalid` below. Both
            // directions are pinned by tests in siwe.test.ts.
            //
            // Residual, accepted: a smart-contract wallet that accepts a
            // 65-byte signature would be evaluated by local recovery and
            // reported `signature_invalid`. Rare, and it fails closed.
            return {
                ok: false,
                reason: "smart_wallet_verification_unavailable",
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
 * The two chains SIWE verification supports. Resolved BEFORE any client is
 * built so an unsupported chainId is a named early return rather than a throw
 * used for control flow — see `siwe_chain_unsupported`.
 */
export function resolveSiweChain(chainId: number): typeof base | typeof baseSepolia | undefined {
    if (chainId === base.id) return base;
    if (chainId === baseSepolia.id) return baseSepolia;
    return undefined;
}

/**
 * The endpoint SIWE verification will actually use for a given chain.
 *
 * ⚠ FALLS BACK TO THE CHAIN'S PUBLIC RPC WHEN BASE_RPC_URL IS UNSET, and that
 * is the point: without it, ERC-1271 (smart-contract wallet) verification is
 * impossible on a stock member node. BASE_RPC_URL cannot ship in the image — it
 * embeds an API key — and members administer their own nodes, so "the operator
 * will set it" is not available for a fleet.
 *
 * Why a public endpoint is acceptable HERE specifically:
 *   - Volume is one eth_call per wallet registration, ever. `verifySiwe` has a
 *     single call site, pinned by a test in siwe.test.ts. If that ever changes,
 *     rate limits start mattering and this decision needs revisiting.
 *   - It is not a new trusted party for this application: the web bundle already
 *     reads through the same endpoint on every Stablecoin page load (wagmi.ts
 *     uses `http()` with no URL, which resolves to exactly this value).
 *   - For Base that endpoint is Coinbase-operated — the same trust root as the
 *     Coinbase Smart Wallet being verified.
 *
 * The residual risk, stated rather than hidden: the RPC is trusted to answer
 * isValidSignature truthfully. A malicious endpoint could forge a positive and
 * let someone bind a wallet they do not control. That mis-attributes balance and
 * history display; it is not fund theft, because the rail is non-custodial and
 * settlements are signed by the wallet itself. An operator wanting a smaller
 * trusted set sets BASE_RPC_URL.
 *
 * Taken from viem's own chain definition rather than a hardcoded string, so it
 * tracks the library instead of drifting from it.
 *
 * ⚠ THIS IS EXPLICIT, NOT LOAD-BEARING ALONE — worth knowing before anyone
 * "simplifies" it away or over-credits it. VERIFIED: viem's own `http("")` and
 * `http(undefined)` ALREADY resolve to `chain.rpcUrls.default.http[0]`, so the
 * single change that actually unblocked stock member nodes was deleting the
 * `if (!rpcUrl) throw` that used to sit above — not this function. It is kept
 * because (a) relying on viem's coercion of an empty string is an implicit
 * dependency on undocumented behaviour, and (b) the client cache needs a concrete
 * url to key on, and `84532:` is not one. Its own unit tests pin it directly;
 * the end-to-end negative control is pinned by restoring that throw.
 */
export function siweRpcUrl(chain: typeof base | typeof baseSepolia, configured: string): string {
    return configured || chain.rpcUrls.default.http[0];
}

/**
 * Build a viem public client for the given BASE chain.
 *
 * Cache is keyed on the RESOLVED url, not the configured one. Keying on the raw
 * input would give an unset-config caller and an explicitly-set-to-public caller
 * two different keys for one identical endpoint.
 */
const clientCache = new Map<string, PublicClient>();
function makePublicClient(chain: typeof base | typeof baseSepolia, rpcUrl: string): PublicClient {
    const url = siweRpcUrl(chain, rpcUrl);
    const key = `${chain.id}:${url}`;
    const cached = clientCache.get(key);
    if (cached) return cached;
    const client = createPublicClient({ chain, transport: http(url) }) as PublicClient;
    clientCache.set(key, client);
    return client;
}
