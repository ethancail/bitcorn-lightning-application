// Environment variable configuration and validation.
// REQUIRED vars have no safe default and must be set before starting.
// All other vars have conservative defaults suitable for first-run operators.
export const ENV = {
    // true when NODE_ENV is not "production"
    isDev: process.env.NODE_ENV !== "production",
    // Set DEBUG=1 or DEBUG=true to enable verbose console output
    debug: process.env.DEBUG === "1" || process.env.DEBUG === "true",

    // "mainnet" | "testnet" | "regtest"
    bitcoinNetwork: process.env.BITCOIN_NETWORK || "mainnet",
    // gRPC address of the LND node; on Umbrel this is the lightning service IP
    lndGrpcHost: process.env.LND_GRPC_HOST || "lightning_lnd_1:10009",
    // REQUIRED: compressed public key of the treasury node (33-byte hex, 66 chars).
    // If unset, no node will be identified as treasury and all treasury endpoints
    // will return 403.
    treasuryPubkey: process.env.TREASURY_PUBKEY || "",

    // --- Rate limits (member payment API) ---
    // Max payments per member per minute
    rateLimitTxPerMinute: parseInt(process.env.RATE_LIMIT_TX_PER_MINUTE || "5", 10),
    // Max sats per member per minute
    rateLimitSatsPerMinute: parseInt(process.env.RATE_LIMIT_SATS_PER_MINUTE || "100000", 10),
    // Max sats per member per hour
    rateLimitSatsPerHour: parseInt(process.env.RATE_LIMIT_SATS_PER_HOUR || "1000000", 10),
    // Max sats in a single payment
    rateLimitMaxSinglePayment: parseInt(process.env.RATE_LIMIT_MAX_SINGLE_PAYMENT || "250000", 10),

    // --- Rebalance viability thresholds ---
    // Minimum remote/capacity ratio (ppm) on the incoming channel to attempt rebalance
    rebalanceMinIncomingRemoteRatioPpm: Number(
        process.env.REBALANCE_MIN_INCOMING_REMOTE_RATIO_PPM ?? "200000"
    ),
    // Minimum local/capacity ratio (ppm) on the outgoing channel to attempt rebalance
    rebalanceMinOutgoingLocalRatioPpm: Number(
        process.env.REBALANCE_MIN_OUTGOING_LOCAL_RATIO_PPM ?? "200000"
    ),
    // Sats to keep back from available liquidity when sizing a rebalance
    rebalanceSafetyBufferSats: Number(process.env.REBALANCE_SAFETY_BUFFER_SATS ?? "1000"),

    // --- Rebalance scheduler ---
    // Set to "true" to enable the automated rebalance scheduler (default: off)
    rebalanceSchedulerEnabled: process.env.REBALANCE_SCHEDULER_ENABLED === "true",
    // Set to "true" to run the scheduler in dry-run mode (logs decisions, no LND calls)
    rebalanceSchedulerDryRun: process.env.REBALANCE_SCHEDULER_DRY_RUN === "true",
    // How often the scheduler ticks, in milliseconds (default: 60s)
    rebalanceSchedulerIntervalMs: Number(
        process.env.REBALANCE_SCHEDULER_INTERVAL_MS ?? "60000"
    ),
    // Default rebalance amount in sats per automated run
    rebalanceDefaultTokens: Number(process.env.REBALANCE_DEFAULT_TOKENS ?? "5000"),
    // Hard ceiling on rebalance amount in sats (caps scheduler and manual requests)
    rebalanceMaxTokens: Number(process.env.REBALANCE_MAX_TOKENS ?? "25000"),
    // Max fee in sats the scheduler will pay for a single rebalance
    rebalanceDefaultMaxFeeSats: Number(
        process.env.REBALANCE_DEFAULT_MAX_FEE_SATS ?? "10"
    ),
    // Max fee-to-amount ratio in ppm the scheduler will tolerate (default: 1000 = 0.1%)
    rebalanceMaxFeePpm: Number(process.env.REBALANCE_MAX_FEE_PPM ?? "1000"),
    // Minimum minutes between two successful automated rebalances
    rebalanceCooldownMinutes: Number(process.env.REBALANCE_COOLDOWN_MINUTES ?? "30"),

    // --- Cluster rebalance engine (v1) ---
    // Set to "true" to enable the cluster-based rebalance engine (fee steering + circular rebalance)
    clusterRebalanceEnabled: process.env.CLUSTER_REBALANCE_ENABLED === "true",
    // Interval between cluster rebalance runs in milliseconds (default: 15 min)
    clusterRebalanceIntervalMs: Number(
        process.env.CLUSTER_REBALANCE_INTERVAL_MS ?? "900000"
    ),

    // --- Loop Out (submarine swap rebalancing via Lightning Terminal / loopd) ---
    // gRPC hostname of the loopd instance (inside litd on Umbrel)
    loopGrpcHost: process.env.LOOP_GRPC_HOST || "lightning-terminal_web_1",
    // gRPC port — litd unified endpoint
    loopGrpcPort: Number(process.env.LOOP_GRPC_PORT ?? "8443"),
    // TLS certificate for the litd gRPC connection
    loopTlsCertPath: process.env.LOOP_TLS_CERT_PATH || "/loop-data/.lit/tls.cert",
    // Loop macaroon for authentication
    loopMacaroonPath: process.env.LOOP_MACAROON_PATH || "/loop-data/.loop/mainnet/loop.macaroon",
    // Max swap fee as a percentage of the swap amount (default: 0.5%)
    loopMaxSwapFeePct: Number(process.env.LOOP_MAX_SWAP_FEE_PCT ?? "0.5"),
    // Max miner fee in sats for the on-chain sweep (default: 20,000)
    loopMaxMinerFeeSats: Number(process.env.LOOP_MAX_MINER_FEE_SATS ?? "20000"),
    // Minimum sats to rebalance via Loop Out (default: 50,000)
    loopMinRebalanceSats: Number(process.env.LOOP_MIN_REBALANCE_SATS ?? "50000"),
    // On-chain confirmation target for the sweep transaction (default: 6 blocks)
    loopConfTarget: Number(process.env.LOOP_CONF_TARGET ?? "6"),

    // --- Coinbase Onramp ---
    // Required to build Onramp URLs. Get from Coinbase Developer Platform.
    // If unset, GET /api/coinbase/onramp-url returns 503.
    coinbaseAppId: process.env.COINBASE_APP_ID || "",
    // Cloudflare Worker URL that generates Coinbase Onramp session tokens.
    // If unset, GET /api/coinbase/onramp-url returns coinbase_not_configured.
    coinbaseWorkerUrl: process.env.COINBASE_WORKER_URL || "",
};
