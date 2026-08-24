// LND (Lightning Network Daemon) client integration
import {
  authenticatedLndGrpc,
  getWalletInfo,
  getIdentity,
  getPeers,
  getChannels,
  getInvoices,
  getForwards,
  getChainBalance,
  getPendingChainBalance,
  getChainTransactions,
  addPeer,
  openChannel,
  closeChannel,
  getPendingChannels,
  createInvoice,
  getRouteToDestination,
  payViaRoutes,
  createChainAddress,
  getUtxos,
  signMessage,
  verifyMessage,
  payViaPaymentDetails,
  sendToChainAddress,
  getChainFeeRate,
  updateAlias
} from "ln-service";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env";
import { LND_DIR, TLS_CERT_PATH } from "./lndPaths";
import {
  withDeadline,
  LND_FAST_CALL_TIMEOUT_MS,
  LND_GOSSIP_CALL_TIMEOUT_MS,
} from "./callDeadline";

// LND_DIR / TLS_CERT_PATH live in ./lndPaths.ts so the expiry inspector shares
// ONE definition with this client rather than re-deriving the path. Re-exported
// here because callers already reach for it via this module.
export { TLS_CERT_PATH } from "./lndPaths";
const MACAROON_PATH = path.join(
  LND_DIR,
  "data",
  "chain",
  "bitcoin",
  ENV.bitcoinNetwork,
  "admin.macaroon"
);

let lndClient: ReturnType<typeof authenticatedLndGrpc> | null = null;

/**
 * sha256 (hex) of the tls.cert BYTES the current `lndClient` was built from.
 * The rebuild precondition, and deliberately a content hash rather than an
 * mtime: mtime moves without content moving (a touch, a backup restore, a
 * container remount), and rebuilding on those would reintroduce exactly the
 * spin this design exists to prevent. Pinned by a test.
 */
let lndClientCertHash: string | null = null;

/** Rebuilds only — the first construction is not a rebuild. */
let lndClientRebuildCount = 0;

/**
 * How many times the memoized client has been REPLACED because the cert bytes
 * changed. Exposed so the no-spin property is observable rather than asserted:
 * a permanent credential fault must leave this at 0 no matter how many LND
 * calls fail. See lnd.certRebuild.test.ts.
 */
export function getLndClientRebuildCount(): number {
  return lndClientRebuildCount;
}

/**
 * Drop the memoized client so the next getLndClient() constructs a fresh one.
 *
 * This is the MECHANISM. The POLICY lives in getLndClient()'s cert-hash gate,
 * and this helper is deliberately NOT wired to any error path — that is the
 * whole safety property. Invalidating on failure is the design this arc
 * rejected: it retries past a permanent auth/permission fault and so hides it,
 * which is the documented failure mode wearing a fix's clothes. Kept exported
 * as the seam for an explicit, deliberate reset.
 */
export function invalidateLndClient(): void {
  lndClient = null;
  lndClientCertHash = null;
}

/**
 * Checks if LND files are available (TLS cert and readonly macaroon)
 * @returns true if both files exist, false otherwise
 */
export function isLndAvailable(): boolean {
  try {
    return (
      fs.existsSync(TLS_CERT_PATH) && fs.existsSync(MACAROON_PATH)
    );
  } catch {
    return false;
  }
}

/**
 * Initializes the LND client if files are available
 * @throws Error if LND files are missing or client initialization fails
 */
export function getLndClient() {
  if (!isLndAvailable()) {
    throw new Error("LND files not available: missing TLS cert or readonly macaroon");
  }

  try {
    // Read + hash BEFORE the memo check: the whole point is that a cert
    // regenerated underneath a live process must be noticed. /lnd is a live
    // bind mount, so the new bytes are visible the moment LND writes them.
    //
    // Cost, stated rather than assumed: one small readFileSync + sha256 per
    // call, where isLndAvailable() above already performs two existsSync
    // syscalls — same order of magnitude on the same hot path.
    const certBytes = fs.readFileSync(TLS_CERT_PATH);
    const certHash = crypto.createHash("sha256").update(certBytes).digest("hex");

    if (lndClient && lndClientCertHash === certHash) {
      return lndClient;
    }

    const isRebuild = lndClient !== null;
    const macaroon = fs.readFileSync(MACAROON_PATH).toString("base64");

    lndClient = authenticatedLndGrpc({
      cert: certBytes.toString("base64"),
      macaroon,
      socket: ENV.lndGrpcHost,
      tls: {
        rejectUnauthorized: false,
      },
    });
    lndClientCertHash = certHash;

    if (isRebuild) {
      lndClientRebuildCount += 1;
      console.warn(
        `[lnd] tls.cert changed on disk — rebuilt the LND client ` +
          `(rebuild #${lndClientRebuildCount}). This is the expected recovery ` +
          `path after LND regenerates its certificate.`,
      );
    }

    return lndClient;
  } catch (err) {
    throw new Error(`Failed to initialize LND client: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Gets LND node information
 * @returns Promise resolving to node info (pubkey, alias, block height, sync status)
 * @throws Error if LND is unavailable or request fails
 */
export async function getLndInfo(): Promise<{
  public_key?: string;
  alias?: string;
  version?: string;
  block_height?: number | null;
  synced_to_chain?: boolean;
}> {
  const { lnd } = getLndClient();

  try {
    const walletInfo = await withDeadline(
      "getLndInfo",
      () => getWalletInfo({ lnd }),
      LND_FAST_CALL_TIMEOUT_MS,
    );

    if (ENV.debug) {
      console.log("[lnd] wallet info:", walletInfo);
    }

    return {
      public_key: walletInfo.public_key,
      alias: walletInfo.alias,
      version: walletInfo.version,
      block_height: walletInfo.current_block_height ?? null,
      synced_to_chain: walletInfo.is_synced_to_chain ?? false,
    };
  } catch (error: any) {
    console.error("🔥 getWalletInfo error:", error);
    throw error;
  }
}

/**
 * Update the local node's public alias (gossiped via node_announcement).
 *
 * Thin wrapper over ln-service `updateAlias` so the two profile endpoints and
 * the startup re-assert share one typed call with consistent error surfacing.
 *
 * Preconditions (member-naming spec §4/§8, verified on Polar regtest 2026-06-16):
 *  - LND built with the `peersrpc` build tag (official Umbrel images include it).
 *  - `peers:write` permission — covered by the admin.macaroon this client loads.
 *  - LND version > 0.14.5 (unsupported below; current Umbrel clears this).
 *
 * Error surfacing from ln-service: missing peersrpc tag -> [400,
 * 'ExpectedPeersRpcLndBuildTagToUpdateAlias']; any other LND error -> [503,
 * 'UnexpectedErrorUpdatingNodeAlias', {err}]. Notably an EMPTY-STRING alias is
 * NOT a usable "unset": LND reports "unable to detect any new values to update
 * the node announcement" (proto3 scalar field presence), which surfaces here as
 * the 503 variant. The clear path therefore re-asserts the pubkey-hex default
 * (see clearNodeAlias) rather than passing "".
 */
export async function updateNodeAlias(alias: string): Promise<void> {
  const { lnd } = getLndClient();
  await withDeadline(
    "updateNodeAlias",
    () => updateAlias({ lnd, alias }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Returns true if an ln-service error is LND's "no new values to update"
 * response — the proto3 no-op described in updateNodeAlias. The clear path
 * treats this as success (the alias is already at the requested value).
 */
function isNoNewValuesError(err: unknown): boolean {
  const text = JSON.stringify(err ?? "").toLowerCase();
  return text.includes("no new values") || text.includes("any new values");
}

/**
 * Clear the local node's public alias by re-asserting the pubkey-derived
 * default-looking value (§8 fallback (a)). Returns the default string applied.
 *
 * Idempotent: if the node's current alias already equals the default, the LND
 * call is skipped (avoids the proto3 "no new values" error on re-clear); if the
 * call is made and LND nonetheless reports "no new values", that is swallowed as
 * success. Any other LND error propagates.
 */
export async function clearNodeAlias(): Promise<string> {
  const { lnd } = getLndClient();
  const info = await withDeadline(
    "clearNodeAlias:read",
    () => getWalletInfo({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
  if (!info.public_key) {
    throw new Error("LND wallet info missing public_key; cannot compute default alias");
  }
  const { lndDefaultAlias } = await import("../profile/aliasValidation");
  const defaultAlias = lndDefaultAlias(info.public_key);

  if (info.alias === defaultAlias) {
    return defaultAlias; // already at the default — nothing to broadcast.
  }
  try {
    await withDeadline(
      "clearNodeAlias:write",
      () => updateAlias({ lnd, alias: defaultAlias }),
      LND_FAST_CALL_TIMEOUT_MS,
    );
  } catch (err) {
    if (!isNoNewValuesError(err)) throw err;
  }
  return defaultAlias;
}

/**
 * Check if the local LND node has keysend enabled by inspecting
 * feature bit 55 in the getWalletInfo response.
 * Returns true if accept-keysend=true is set in LND config.
 * Falls back to false if features field is absent.
 */
export async function isKeysendEnabled(): Promise<boolean> {
  const { lnd } = getLndClient();
  const info = await withDeadline(
    "isKeysendEnabled",
    () => getWalletInfo({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
  if (!info.features || !Array.isArray(info.features)) return false;
  const keysendBit = info.features.find((f) => f.bit === 55);
  return !!keysendBit?.is_known;
}

/**
 * Lists connected LND peers (read-only)
 */
export async function getLndPeers() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndPeers",
    () => getPeers({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Lists open LND channels (read-only)
 */
export async function getLndChannels() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndChannels",
    () => getChannels({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets LND invoices
 */
export async function getLndInvoices() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndInvoices",
    () => getInvoices({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets LND forwarding history (routing revenue).
 *
 * ⚠ THE DEADLINE BOUNDS ONE PAGE, NOT THE OPERATION. syncForwardingHistory()
 * calls this in a do/while until the pagination token runs out, so the sync
 * tick's exposure here is pages × deadline, with no bound on the page count.
 * Bounding the WALK is a per-tick budget, deliberately deferred — see
 * callDeadline.ts's composition note and lightning/syncTiming.ts.
 */
export async function getLndForwards(options?: {
  after?: string;
  before?: string;
  limit?: number;
  token?: string;
}) {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndForwards",
    () => getForwards({ lnd, ...options }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets confirmed on-chain balance.
 */
export async function getLndChainBalance() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndChainBalance",
    () => getChainBalance({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets our node's public key (for circular rebalance destination).
 */
export async function getLndIdentity() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndIdentity",
    () => getIdentity({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Creates an invoice on the treasury node (e.g. for self-pay rebalance).
 */
export async function createLndInvoice(tokens: number, description?: string) {
  const { lnd } = getLndClient();
  return withDeadline(
    "createLndInvoice",
    () => createInvoice({ lnd, tokens, description }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets a route to a destination with optional outgoing channel and incoming peer (for circular rebalance).
 */
export async function getLndRouteToDestination(options: {
  destination: string;
  tokens: number;
  outgoing_channel?: string;
  incoming_peer?: string;
  max_fee?: number;
  payment?: string;
  total_mtokens?: string;
}) {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndRouteToDestination",
    () => getRouteToDestination({ lnd, ...options }),
    LND_GOSSIP_CALL_TIMEOUT_MS,
  );
}

/**
 * Pays via a pre-built route (e.g. circular rebalance).
 *
 * ⚠ HELD — NO DEADLINE, DELIBERATELY. In HELD_UNBOUNDED_CALLS (callDeadline.ts).
 * A deadline cannot cancel the call, so giving up on an in-flight payment leaves
 * the outcome UNKNOWN: the HTLC may already have settled. Retrying is a double
 * spend, not retrying is a lost payment, and nothing local can tell which.
 * Slow is better than ambiguous here. Pinned by heldCalls.test.ts.
 */
export type LndRoute = Awaited<ReturnType<typeof getLndRouteToDestination>>["route"];

export async function payLndViaRoutes(id: string, routes: LndRoute[]) {
  const { lnd } = getLndClient();
  return payViaRoutes({ lnd, id, routes });
}

/**
 * Gets channels in pending state (opening/closing). Used for guardrail
 * accounting so pending capacity is correct even if channels were opened outside the app.
 */
export async function getLndPendingChannels() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndPendingChannels",
    () => getPendingChannels({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Cooperatively (or force) closes a channel by its funding outpoint.
 * Returns the closing transaction ID once broadcast.
 *
 * ⚠ HELD — NO DEADLINE, DELIBERATELY. In HELD_UNBOUNDED_CALLS (callDeadline.ts).
 * A close broadcasts an on-chain transaction and a deadline cannot cancel it, so
 * timing out would leave us unsure whether the channel is closing. A cooperative
 * close also legitimately takes as long as the peer takes to respond.
 * Pinned by heldCalls.test.ts.
 */
export async function closeTreasuryChannel(
  transactionId: string,
  transactionVout: number,
  options?: { isForce?: boolean; chainFeeTokensPerVbyte?: number }
): Promise<{ transaction_id?: string }> {
  const { lnd } = getLndClient();
  return closeChannel({
    lnd,
    transaction_id: transactionId,
    transaction_vout: transactionVout,
    is_force_close: options?.isForce ?? false,
    tokens_per_vbyte: options?.chainFeeTokensPerVbyte,
  });
}

/**
 * Connects to a peer (optional - Phase 1 requires peer already connected).
 */
export async function connectToPeer(publicKey: string, socket?: string) {
  const { lnd } = getLndClient();
  if (socket) {
    await withDeadline(
      "connectToPeer",
      () => addPeer({ lnd, public_key: publicKey, socket }),
      LND_FAST_CALL_TIMEOUT_MS,
    );
  }
}

/**
 * Opens a channel from treasury to a peer.
 *
 * ⚠ HELD — NO DEADLINE, DELIBERATELY. In HELD_UNBOUNDED_CALLS (callDeadline.ts).
 * An open commits the funding transaction. A deadline cannot cancel it, so
 * timing out would leave capital committed with the caller believing it failed —
 * and the expansion-execution row would record a failure against a channel that
 * is in fact opening. Pinned by heldCalls.test.ts.
 */
export async function openTreasuryChannel(
  peerPubkey: string,
  capacitySats: number,
  options?: {
    isPrivate?: boolean;
    chainFeeTokensPerVbyte?: number;
    minConfirmations?: number;
    partnerSocket?: string;
  }
) {
  const { lnd } = getLndClient();
  return openChannel({
    lnd,
    partner_public_key: peerPubkey,
    local_tokens: capacitySats,
    is_private: options?.isPrivate ?? false,
    chain_fee_tokens_per_vbyte: options?.chainFeeTokensPerVbyte,
    min_confirmations: options?.minConfirmations,
    partner_socket: options?.partnerSocket,
  });
}

/**
 * Gets pending (unconfirmed) on-chain balance.
 */
export async function getLndPendingChainBalance() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndPendingChainBalance",
    () => getPendingChainBalance({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Gets on-chain transaction history from LND.
 */
export async function getLndChainTransactions() {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndChainTransactions",
    () => getChainTransactions({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Generates a fresh native-segwit (bech32) on-chain receiving address.
 * Each Coinbase Onramp session should use a new address.
 */
export async function createLndChainAddress(): Promise<{ address: string }> {
  const { lnd } = getLndClient();
  return withDeadline(
    "createLndChainAddress",
    () => createChainAddress({ lnd, format: "p2wpkh" }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Sends a fixed amount of on-chain sats to a destination address from
 * the local LND wallet. Used by the subscription pay-from-node flow
 * (POST /api/subscription/pay-from-node) — the member pays their own
 * subscription deposit address from their node's on-chain wallet.
 *
 * Returns the broadcast transaction's id (the txid). Defaults to a
 * 6-block confirmation target (subscription deadlines are day-scale —
 * see the implementation deltas — so next-block fees are waste).
 *
 * ⚠ HELD — NO DEADLINE, DELIBERATELY. In HELD_UNBOUNDED_CALLS (callDeadline.ts).
 * This is the sharpest case of the six: it broadcasts a member's subscription
 * payment. A deadline cannot cancel the broadcast, so timing out would release
 * payFromNode.ts's send lock with the transaction possibly already on the wire,
 * and the next tick would pay again. payFromNode.ts:183-187 accepts double-send
 * risk only across an API restart — a rare event; a routine timeout would make
 * it routine. Pinned by heldCalls.test.ts.
 */
export async function sendLndToChainAddress(
  address: string,
  tokens: number,
  targetConfirmations = 6,
): Promise<{ id: string; tokens: number; is_confirmed: boolean }> {
  const { lnd } = getLndClient();
  return sendToChainAddress({
    lnd,
    address,
    tokens,
    target_confirmations: targetConfirmations,
  });
}

/**
 * Returns the current estimated on-chain fee RATE (sats per vByte) for
 * a given confirmation target. This is a rate, not a total fee — the
 * caller multiplies by an estimated transaction vsize. Backs the
 * pay-from-node quote's fee preview (the fee number must come from the
 * member's local LND, which the treasury can't compute).
 */
export async function getLndChainFeeRate(
  confirmationTarget = 6,
): Promise<{ tokens_per_vbyte: number }> {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndChainFeeRate",
    () => getChainFeeRate({ lnd, confirmation_target: confirmationTarget }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Lists unspent on-chain UTXOs known to LND, with per-output address
 * and amount. Used by the subscription-rail detector (filtered to
 * subscription deposit addresses) and by `getDeployableChainBalance()`
 * (sum of unswept subscription receipts).
 */
export async function getLndUtxos(args: { min_confirmations?: number } = {}) {
  const { lnd } = getLndClient();
  return withDeadline(
    "getLndUtxos",
    () => getUtxos({ lnd, ...args }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

/**
 * Signs a message with LND's identity key (secp256k1 ECDSA on a
 * sha256d hash). Used by the subscription entitlement-token member
 * auth to prove control of the local node's pubkey.
 */
export async function lndSignMessage(message: string): Promise<string> {
  const { lnd } = getLndClient();
  const { signature } = await withDeadline(
    "lndSignMessage",
    () => signMessage({ lnd, message }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
  return signature;
}

/**
 * Verifies a signed message and returns the pubkey that signed it.
 * Used by the treasury's challenge-auth middleware on
 * `/api/subscription/token` to authenticate the requester. The pubkey
 * the caller claims must equal the pubkey returned by this call.
 */
export async function lndVerifyMessage(
  message: string,
  signature: string,
): Promise<string> {
  const { lnd } = getLndClient();
  const { signed_by } = await withDeadline(
    "lndVerifyMessage",
    () => verifyMessage({ lnd, message, signature }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
  return signed_by;
}

/**
 * Preflight probe: checks whether a Lightning payment can route from
 * any known Loop swap server to the local node for a given amount.
 *
 * Uses queryRoutes with source_pub_key (via ln-service's `start` param)
 * to simulate the route FROM the server TO us, using the local gossip graph.
 * The route necessarily passes through treasury's external channels.
 *
 * Never throws — returns a result object.
 */
export async function probeRouteToLoopServer(
  merchantPubkey: string,
  amountSat: number,
): Promise<{ routable: boolean; serverPubkey?: string; error?: string }> {
  let lnd: any;
  try {
    ({ lnd } = getLndClient());
  } catch (err) {
    return {
      routable: false,
      error: `LND unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const servers = ENV.loopServerPubkeys;

  // ⚠ THE DEADLINE IS PER SERVER, NOT PER PROBE. This loops over every
  // configured Loop server, so the worst case is servers.length × the gossip
  // deadline, not one deadline. Same composition caveat as the paginated reads
  // and the sync tick — see callDeadline.ts's header.
  for (const serverPubkey of servers) {
    try {
      const result = await withDeadline(
        "probeRouteToLoopServer",
        () => getRouteToDestination({
          lnd,
          destination: merchantPubkey,
          tokens: amountSat,
          start: serverPubkey,
        }),
        LND_GOSSIP_CALL_TIMEOUT_MS,
      );
      if (result?.route) {
        return { routable: true, serverPubkey };
      }
    } catch {
      // No route from this server — try next
      continue;
    }
  }

  return {
    routable: false,
    error: `No route found from any Loop server (${servers.length} checked) to ${merchantPubkey.slice(0, 12)}... for ${amountSat} sats`,
  };
}

/**
 * Keysend push: sends sats directly to a peer via their pubkey using
 * payViaPaymentDetails. No invoice needed — the payment preimage is
 * generated locally and included via the keysend TLV (type 5482373484).
 *
 * @param destination - Peer's public key
 * @param tokens - Amount in sats to push
 * @param maxFee - Maximum routing fee in sats (usually 0 for direct peer)
 * @param outgoingChannel - Optional: force payment through this channel
 *
 * ⚠ HELD — NO DEADLINE, DELIBERATELY. In HELD_UNBOUNDED_CALLS (callDeadline.ts).
 * Keysend push permanently transfers sats. A deadline cannot cancel the payment,
 * so timing out leaves the treasury unsure whether the push landed — and the
 * member_liquidity_recommendations row would be marked failed against a transfer
 * that succeeded. Pinned by heldCalls.test.ts.
 */
export async function keysendPush(options: {
  destination: string;
  tokens: number;
  max_fee?: number;
  outgoing_channel?: string;
}): Promise<{
  fee: number;
  id: string;
  is_confirmed: boolean;
  tokens: number;
  secret: string;
}> {
  const { lnd } = getLndClient();
  const preimage = crypto.randomBytes(32);
  const id = crypto.createHash("sha256").update(preimage).digest("hex");

  return payViaPaymentDetails({
    lnd,
    destination: options.destination,
    tokens: options.tokens,
    id,
    max_fee: options.max_fee ?? 0,
    outgoing_channel: options.outgoing_channel,
    features: [{ type: 9, is_required: true }],
    messages: [{
      type: "5482373484",
      value: preimage.toString("hex"),
    }],
  });
}
