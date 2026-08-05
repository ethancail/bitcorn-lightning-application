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
    isHex,
    size,
    verifyMessage as verifyMessageLocal,
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
               *
               * ⚠ REACHABLE FROM THE CONTRACT BRANCH ONLY. Since the shape
               * router landed, an EOA-shaped signature is verified locally and
               * touches no network, so it can never produce this reason. If you
               * see it, the signature was not 65 bytes.
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
     * such as Coinbase Smart Wallet.
     *
     * Empty string is the stock member-node state and is NOT a failure: it
     * resolves to the chain's public RPC (see siweRpcUrl). It is also irrelevant
     * to an EOA signature, which is verified locally and reaches no endpoint at
     * all — so this field only ever matters on the contract branch.
     */
    baseRpcUrl: string;
}

/**
 * Verify a signed SIWE message against an issued challenge.
 *
 * Seven checks, in this order — the signature is LAST on purpose, so the cheap
 * structural rejections never pay for cryptography or a network read:
 *   1. Parse the message (well-formed EIP-4361)
 *   2. message.domain and chainId match what the API issued
 *   3. message.address matches the stored wallet_address
 *   4. message.nonce matches the stored nonce
 *   5. message.expirationTime > now
 *   6. The Lightning pubkey resource in the message matches the stored member_pubkey
 *   7. Signature verifies for message.address — locally for an EOA-shaped
 *      signature, on-chain (ERC-1271) otherwise. Exactly one of those two paths
 *      runs per signature and its rejection is final; see the shape router.
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
    //
    // ONE VERIFICATION PATH PER SIGNATURE, SELECTED BY SHAPE. A REJECTION FROM
    // THAT PATH IS FINAL. There is no fall-back-and-try-again anywhere below,
    // and that is the security property this section exists to hold.
    //
    // Chain first, as a named outcome — BEFORE the shape router, deliberately.
    // An unsupported chainId blocks registration for EVERY wallet type, because
    // it means BASE_CHAIN_ID names a chain this node cannot verify against at
    // all; letting an EOA through on a misconfigured node would bind wallets
    // against the wrong network. An unsupported chainId is an operator
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

    // ── THE SHAPE ROUTER ────────────────────────────────────────────────────
    //
    // An EOA signature is verified LOCALLY, with no network access of any kind.
    // The chain is reached only for a signature that genuinely needs ERC-1271.
    // MetaMask/EOA is the only wallet path that works on a stock member node
    // (Coinbase is blocked by secure context — see app/web/src/stablecoin/
    // wagmi.ts), so every farmer registering a wallet goes through the EOA
    // branch, and it must not depend on a public RPC with no SLA.
    //
    // ⚠ WHY ROUTING IS ALSO A SECURITY IMPROVEMENT, NOT JUST A LATENCY ONE.
    // viem's verifyHash runs in mode 'auto', which calls the ERC-6492 validator
    // on-chain and then, in an OUTER CATCH, retries with local ECDSA recovery
    // and returns true if that matches. That catch is reached on an explicit
    // on-chain REJECTION as well as on transport failure — verifyErc6492 turns
    // `hexToBool(data) === false` into a thrown VerificationError. So before
    // this router, a signature the chain had explicitly rejected could still be
    // accepted by local recovery: two chances, and the weaker one decided.
    // The router removes that by construction. Only non-65-byte signatures now
    // reach viem, and local recovery THROWS on those (measured: "invalid
    // signature length"), so viem's outer catch can no longer produce an accept.
    //
    // ⚠ REJECTED ALTERNATIVE — DO NOT RE-PROPOSE. On the EOA branch, when local
    // recovery returns false, fall through to the chain, on the theory that a
    // false might mean "65-byte contract signature" rather than "bad signature."
    // Rejected: it reintroduces sequential verification on the exact path this
    // arc cleans up, adds a round-trip to the EOA failure path, and buys back
    // only the currently-unreachable 65-byte-contract-wallet case documented on
    // isEoaShapedSignature. One path with a final rejection is worth more than
    // that coverage.
    if (isEoaShapedSignature(input.signature)) {
        // EOA branch — NO client is built and no fetch is issued. That is the
        // property under test: siwe.test.ts asserts zero fetch invocations here.
        let valid: boolean;
        try {
            valid = await verifyMessageLocal({
                address: parsed.address as Hex,
                message: input.message,
                signature: input.signature,
            });
        } catch {
            // A 65-byte signature recovery cannot evaluate — malformed r, an
            // invalid v byte, or a point not on the curve (all measured to throw
            // rather than return false). That IS a bad signature, so it is
            // `signature_invalid` and NOT the unavailable reason: nothing about
            // the network was involved in reaching this line. Routing it to 503
            // would tell the member to try again at something that can only fail.
            return { ok: false, reason: "signature_invalid" };
        }
        if (!valid) {
            return { ok: false, reason: "signature_invalid" };
        }
    } else {
        // Contract branch — ERC-1271 / ERC-6492, which is inherently a chain read.
        //
        // ⚠ CONSTRUCTION MUST NOT THROW — it is outside the try, so anything
        // thrown here escapes verifySiwe instead of becoming an outcome. It
        // cannot today: the chain is already resolved above, siweRpcUrl cannot
        // throw, and viem's createPublicClient accepts even a malformed url
        // (VERIFIED: "not-a-url", "ftp://x" and "   " all construct; the failure
        // surfaces at call time, which IS inside the try). If you add a throwing
        // step to makePublicClient, move the call inside the try and give the
        // liveness probe its own client.
        const client = makePublicClient(chain, input.baseRpcUrl);
        let valid: boolean;
        try {
            valid = await client.verifyMessage({
                address: parsed.address as Hex,
                message: input.message,
                signature: input.signature,
            });
        } catch (err) {
            // Nothing was evaluated — not an authentication failure.
            return {
                ok: false,
                reason: "smart_wallet_verification_unavailable",
                detail:
                    "chain read for ERC-1271 verification failed: " +
                    (err instanceof Error ? err.message : String(err)),
            };
        }
        if (!valid) {
            // ⚠ A `false` FROM viem IS AMBIGUOUS, and only on this branch.
            //
            // MEASURED: verifyMessage SWALLOWS transport failures and returns
            // false rather than throwing (forced fetch rejection → false). The
            // mechanism: getCallError wraps ANY error — transport included — as
            // CallExecutionError, verifyErc6492 converts that to
            // VerificationError, and verifyHash maps VerificationError to false.
            // So a bare false conflates two different things:
            //     the contract said this signature is not valid
            //     the chain read failed, so nothing was checked
            //
            // getChainId THROWS on transport failure where verifyMessage does not
            // (both measured), so it disambiguates. The mapping is now direct
            // rather than routed through a catch: probe throws ⇒ unavailable,
            // probe answers ⇒ the contract genuinely rejected the signature.
            // Costs one round-trip, and only on the negative path.
            try {
                await client.getChainId();
            } catch (err) {
                return {
                    ok: false,
                    reason: "smart_wallet_verification_unavailable",
                    detail:
                        "chain read for ERC-1271 verification failed: " +
                        (err instanceof Error ? err.message : String(err)),
                };
            }
            return { ok: false, reason: "signature_invalid" };
        }
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

/**
 * Is this signature shaped like a raw secp256k1 EOA signature (r‖s‖v, 65 bytes)?
 *
 * The discriminator for the one-path-per-signature router in `verifySiwe`. An
 * explicit length test, NOT a try/catch around local recovery — even though
 * recovery does throw on non-65-byte input and would therefore "work" as a
 * router. The reason is that a throw cannot distinguish two cases that need
 * different outcomes:
 *
 *   not 65 bytes          → a contract signature; needs the chain; a 503 if the
 *                           chain cannot be reached
 *   65 bytes, malformed   → a BAD signature (invalid r, bad v byte, point not on
 *                           the curve — all measured to throw); a 401, and no
 *                           network involvement is warranted
 *
 * Routing on the throw would file the second case as the first. Being explicit
 * also makes the predicate greppable and unit-testable on its own.
 *
 * ⚠ RESIDUAL, ACCEPTED — and the position changed with this arc, so read this
 * rather than assuming the old one. A contract wallet whose signature happens to
 * be exactly 65 bytes — the concrete instance is a 1-of-1 Gnosis Safe, whose
 * `signatures` blob for a single ECDSA owner is r‖s‖v — routes to LOCAL recovery
 * by shape. Recovery yields the owner EOA, which is not the Safe's address, so it
 * is rejected as `signature_invalid`. It is now rejected ALWAYS, regardless of
 * RPC health, where previously a healthy RPC would have verified it on-chain and
 * accepted it. Fails closed: the failure direction is refusal, never a wrong
 * accept.
 *
 * Accepted because no such signature can currently arrive: the picker offers
 * Coinbase (blocked by secure context on every stock node) and MetaMask, and
 * WalletConnect — the usual route for a Safe — is unconfigured. A 2-of-3 Safe,
 * including the treasury's own, produces ~130 bytes and routes to the chain
 * branch correctly. Revisit if WalletConnect is ever configured.
 */
export function isEoaShapedSignature(signature: Hex): boolean {
    return isHex(signature) && size(signature) === 65;
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
