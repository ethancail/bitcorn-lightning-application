// loopd gRPC client — communicates with Lightning Terminal (litd) subserver
// Analogous to lnd.ts but for Loop submarine swap operations.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env";

// ─── Proto loading ───────────────────────────────────────────────────────────

const PROTO_DIR = path.resolve(__dirname, "../../proto");

const packageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "looprpc/client.proto"),
  {
    includeDirs: [PROTO_DIR],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }
);

const proto = grpc.loadPackageDefinition(packageDef) as any;

// ─── Client singleton ────────────────────────────────────────────────────────

let swapClient: any = null;

function getSwapClient(): any {
  if (swapClient) return swapClient;

  const certPath = ENV.loopTlsCertPath;
  const macPath = ENV.loopMacaroonPath;

  if (!fs.existsSync(certPath)) {
    throw new Error(`Loop TLS cert not found: ${certPath}`);
  }
  if (!fs.existsSync(macPath)) {
    throw new Error(`Loop macaroon not found: ${macPath}`);
  }

  const cert = fs.readFileSync(certPath);
  const macaroon = fs.readFileSync(macPath).toString("hex");

  const sslCreds = grpc.credentials.createSsl(cert);
  const macCreds = grpc.credentials.createFromMetadataGenerator(
    (_params, callback) => {
      const metadata = new grpc.Metadata();
      metadata.add("macaroon", macaroon);
      callback(null, metadata);
    }
  );
  const combinedCreds = grpc.credentials.combineChannelCredentials(
    sslCreds,
    macCreds
  );

  const host = `${ENV.loopGrpcHost}:${ENV.loopGrpcPort}`;
  // litd's TLS cert may not include the Docker DNS name as a SAN.
  // Override the target name to match a SAN in the cert (localhost).
  swapClient = new proto.looprpc.SwapClient(host, combinedCreds, {
    "grpc.ssl_target_name_override": "localhost",
  });
  return swapClient;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert ln-service short channel ID (e.g. "939318x1492x1") to the uint64
 * string that loopd's proto expects. Channel ID uint64s exceed
 * Number.MAX_SAFE_INTEGER, so we use BigInt for the calculation.
 */
function shortChannelIdToUint64(scid: string): string {
  const parts = scid.split("x");
  if (parts.length !== 3) return scid; // already numeric — pass through
  const [block, tx, output] = parts.map(Number);
  const id =
    (BigInt(block) << 40n) | (BigInt(tx) << 16n) | BigInt(output);
  return id.toString();
}

/** Wrap a gRPC unary call in a Promise with a deadline. */
function rpcCall<T>(
  method: string,
  request: Record<string, unknown>,
  deadlineMs = 30_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = getSwapClient();
    const deadline = new Date(Date.now() + deadlineMs);
    client[method](request, { deadline }, (err: any, res: T) => {
      if (err) {
        reject(
          new Error(
            `Loop RPC ${method} failed: ${err.details || err.message} (code ${err.code})`
          )
        );
      } else {
        resolve(res);
      }
    });
  });
}

// ─── Exported functions ──────────────────────────────────────────────────────

export type LoopAvailability = {
  available: boolean;
  version?: string;
  error?: string;
};

/**
 * Check whether loopd is reachable and authenticated.
 * Never throws — always returns a result.
 */
export async function isLoopAvailable(): Promise<LoopAvailability> {
  try {
    if (
      !fs.existsSync(ENV.loopTlsCertPath) ||
      !fs.existsSync(ENV.loopMacaroonPath)
    ) {
      return { available: false, error: "Loop credentials not found" };
    }
    const info = await rpcCall<{ version?: string }>("GetInfo", {}, 5_000);
    return { available: true, version: info.version };
  } catch (err: any) {
    return { available: false, error: err.message };
  }
}

export type LoopOutTerms = {
  min_swap_amount: number;
  max_swap_amount: number;
};

/** Get the minimum and maximum swap amounts for Loop Out. */
export async function getLoopOutTerms(): Promise<LoopOutTerms> {
  const res = await rpcCall<{
    min_swap_amount: number;
    max_swap_amount: number;
  }>("LoopOutTerms", {});
  return {
    min_swap_amount: Number(res.min_swap_amount),
    max_swap_amount: Number(res.max_swap_amount),
  };
}

export type LoopOutQuote = {
  swap_fee_sat: number;
  prepay_amt_sat: number;
  miner_fee: number;
  total_cost_sats: number;
  conf_target: number;
};

/** Get a cost quote for a Loop Out swap of a given amount. */
export async function getLoopOutQuote(
  amountSats: number,
  confTarget?: number
): Promise<LoopOutQuote> {
  const target = confTarget ?? ENV.loopConfTarget;
  const res = await rpcCall<{
    swap_fee_sat: number;
    prepay_amt_sat: number;
    htlc_sweep_fee_sat: number;
  }>("LoopOutQuote", { amt: amountSats, conf_target: target });

  const swapFee = Number(res.swap_fee_sat);
  const prepay = Number(res.prepay_amt_sat);
  const minerFee = Number(res.htlc_sweep_fee_sat);

  return {
    swap_fee_sat: swapFee,
    prepay_amt_sat: prepay,
    miner_fee: minerFee,
    total_cost_sats: swapFee + prepay + minerFee,
    conf_target: target,
  };
}

export type LoopOutSwapResult = {
  swap_hash: string;
  id: string;
  server_message: string;
};

/** Initiate a Loop Out swap. */
export async function executeLoopOutSwap(params: {
  amt: number;
  dest: string;
  outgoing_chan_set: string[];
  max_swap_fee: number;
  max_miner_fee: number;
  sweep_conf_target: number;
}): Promise<LoopOutSwapResult> {
  // Convert short channel IDs (e.g. "939318x1492x1") to uint64 strings for loopd proto
  const chanSet = params.outgoing_chan_set.map(shortChannelIdToUint64);
  const res = await rpcCall<{
    id_bytes: Buffer | string;
    server_message: string;
  }>(
    "LoopOut",
    {
      amt: params.amt,
      dest: params.dest,
      outgoing_chan_set: chanSet,
      max_swap_fee: params.max_swap_fee,
      max_miner_fee: params.max_miner_fee,
      sweep_conf_target: params.sweep_conf_target,
      max_prepay_routing_fee: params.max_swap_fee,
      max_swap_routing_fee: params.max_swap_fee,
    },
    60_000 // longer deadline for swap initiation
  );

  const hashHex =
    typeof res.id_bytes === "string"
      ? res.id_bytes
      : Buffer.from(res.id_bytes).toString("hex");

  return {
    swap_hash: hashHex,
    id: hashHex,
    server_message: res.server_message || "",
  };
}

// Swap state strings returned by loopd
export type SwapState =
  | "INITIATED"
  | "PREIMAGE_REVEALED"
  | "HTLC_PUBLISHED"
  | "SUCCESS"
  | "FAILED"
  | "INVOICE_SETTLED"
  | string;

export type SwapInfo = {
  id: string;
  type: string;
  state: SwapState;
  amount: number;
  cost_server: number;
  cost_onchain: number;
  cost_offchain: number;
  initiation_time: number;
  last_update_time: number;
};

/** List all Loop swaps (in-flight and completed). */
export async function listLoopSwaps(): Promise<SwapInfo[]> {
  const res = await rpcCall<{ swaps: any[] }>("ListSwaps", {});
  return (res.swaps || []).map((s) => ({
    id:
      typeof s.id_bytes === "string"
        ? s.id_bytes
        : Buffer.from(s.id_bytes || "").toString("hex"),
    type: s.type || "LOOP_OUT",
    state: s.state || "UNKNOWN",
    amount: Number(s.amt || 0),
    cost_server: Number(s.cost_server || 0),
    cost_onchain: Number(s.cost_onchain || 0),
    cost_offchain: Number(s.cost_offchain || 0),
    initiation_time: Number(s.initiation_time || 0),
    last_update_time: Number(s.last_update_time || 0),
  }));
}
