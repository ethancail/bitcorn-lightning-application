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
  getChainFeeRate
} from "ln-service";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env";

const LND_DIR = process.env.LND_DIR ?? "/lnd";
const TLS_CERT_PATH = path.join(LND_DIR, "tls.cert");
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

  if (lndClient) {
    return lndClient;
  }

  try {
    const cert = fs.readFileSync(TLS_CERT_PATH).toString("base64");
    const macaroon = fs.readFileSync(MACAROON_PATH).toString("base64");

    lndClient = authenticatedLndGrpc({
      cert,
      macaroon,
      socket: ENV.lndGrpcHost,
      tls: {
        rejectUnauthorized: false,
      },
    });

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
    const walletInfo = await getWalletInfo({ lnd });

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
 * Check if the local LND node has keysend enabled by inspecting
 * feature bit 55 in the getWalletInfo response.
 * Returns true if accept-keysend=true is set in LND config.
 * Falls back to false if features field is absent.
 */
export async function isKeysendEnabled(): Promise<boolean> {
  const { lnd } = getLndClient();
  const info = await getWalletInfo({ lnd });
  if (!info.features || !Array.isArray(info.features)) return false;
  const keysendBit = info.features.find((f) => f.bit === 55);
  return !!keysendBit?.is_known;
}

/**
 * Lists connected LND peers (read-only)
 */
export async function getLndPeers() {
  const { lnd } = getLndClient();
  return getPeers({ lnd });
}

/**
 * Lists open LND channels (read-only)
 */
export async function getLndChannels() {
  const { lnd } = getLndClient();
  return getChannels({ lnd });
}

/**
 * Gets LND invoices
 */
export async function getLndInvoices() {
  const { lnd } = getLndClient();
  return getInvoices({ lnd });
}

/**
 * Gets LND forwarding history (routing revenue).
 */
export async function getLndForwards(options?: {
  after?: string;
  before?: string;
  limit?: number;
  token?: string;
}) {
  const { lnd } = getLndClient();
  return getForwards({ lnd, ...options });
}

/**
 * Gets confirmed on-chain balance.
 */
export async function getLndChainBalance() {
  const { lnd } = getLndClient();
  return getChainBalance({ lnd });
}

/**
 * Gets our node's public key (for circular rebalance destination).
 */
export async function getLndIdentity() {
  const { lnd } = getLndClient();
  return getIdentity({ lnd });
}

/**
 * Creates an invoice on the treasury node (e.g. for self-pay rebalance).
 */
export async function createLndInvoice(tokens: number, description?: string) {
  const { lnd } = getLndClient();
  return createInvoice({ lnd, tokens, description });
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
  return getRouteToDestination({ lnd, ...options });
}

/**
 * Pays via a pre-built route (e.g. circular rebalance).
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
  return getPendingChannels({ lnd });
}

/**
 * Cooperatively (or force) closes a channel by its funding outpoint.
 * Returns the closing transaction ID once broadcast.
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
    await addPeer({ lnd, public_key: publicKey, socket });
  }
}

/**
 * Opens a channel from treasury to a peer.
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
  return getPendingChainBalance({ lnd });
}

/**
 * Gets on-chain transaction history from LND.
 */
export async function getLndChainTransactions() {
  const { lnd } = getLndClient();
  return getChainTransactions({ lnd });
}

/**
 * Generates a fresh native-segwit (bech32) on-chain receiving address.
 * Each Coinbase Onramp session should use a new address.
 */
export async function createLndChainAddress(): Promise<{ address: string }> {
  const { lnd } = getLndClient();
  return createChainAddress({ lnd, format: "p2wpkh" });
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
  return getChainFeeRate({ lnd, confirmation_target: confirmationTarget });
}

/**
 * Lists unspent on-chain UTXOs known to LND, with per-output address
 * and amount. Used by the subscription-rail detector (filtered to
 * subscription deposit addresses) and by `getDeployableChainBalance()`
 * (sum of unswept subscription receipts).
 */
export async function getLndUtxos(args: { min_confirmations?: number } = {}) {
  const { lnd } = getLndClient();
  return getUtxos({ lnd, ...args });
}

/**
 * Signs a message with LND's identity key (secp256k1 ECDSA on a
 * sha256d hash). Used by the subscription entitlement-token member
 * auth to prove control of the local node's pubkey.
 */
export async function lndSignMessage(message: string): Promise<string> {
  const { lnd } = getLndClient();
  const { signature } = await signMessage({ lnd, message });
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
  const { signed_by } = await verifyMessage({ lnd, message, signature });
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

  for (const serverPubkey of servers) {
    try {
      const result = await getRouteToDestination({
        lnd,
        destination: merchantPubkey,
        tokens: amountSat,
        start: serverPubkey,
      });
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
