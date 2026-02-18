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
  addPeer,
  openChannel,
  closeChannel,
  getPendingChannels,
  createInvoice,
  getRouteToDestination,
  payViaRoutes
} from "ln-service";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env";

const LND_DIR = "/lnd";
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
export async function createLndInvoice(tokens: number) {
  const { lnd } = getLndClient();
  return createInvoice({ lnd, tokens });
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
  options?: { isForce?: boolean }
): Promise<{ transaction_id?: string }> {
  const { lnd } = getLndClient();
  return closeChannel({
    lnd,
    transaction_id: transactionId,
    transaction_vout: transactionVout,
    is_force_close: options?.isForce ?? false,
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
