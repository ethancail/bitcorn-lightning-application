// LND (Lightning Network Daemon) client integration
import {
  authenticatedLndGrpc,
  getInfo,
  getIdentity,
  getPeers,
  getChannels
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
function getLndClient() {
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
 * Gets LND wallet/node information
 * @returns Promise resolving to wallet/node info (pubkey, alias, etc.)
 * @throws Error if LND is unavailable or request fails
 */
export async function getLndInfo(): Promise<{
  public_key?: string;
  alias?: string;
  version?: string;
  active_channels_count?: number;
  peers_count?: number;
  block_height?: number;
  block_hash?: string;
  synced_to_chain?: boolean;
  synced_to_graph?: boolean;
}> {
  const { lnd } = getLndClient();

  try {
    const info = await getInfo({ lnd });
    return {
      public_key: info.public_key,
      alias: info.alias,
      version: info.version,
      active_channels_count: info.active_channels_count,
      peers_count: info.peers_count,
      block_height: info.block_height,
      block_hash: info.block_hash,
      synced_to_chain: info.synced_to_chain,
      synced_to_graph: info.synced_to_graph,
    };
  } catch (err: any) {
    console.error("🔥 getInfo error FULL OBJECT:");
    console.error(err);
    console.error("🔥 error.message:", err?.message);
    console.error("🔥 error.code:", err?.code);
    console.error("🔥 error.details:", err?.details);
  
    try {
      const identity = await getIdentity({ lnd });
      return {
        public_key: identity.public_key,
      };
    } catch (fallbackErr: any) {
      console.error("🔥 getIdentity fallback error:");
      console.error(fallbackErr);
      throw fallbackErr;
    }
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
