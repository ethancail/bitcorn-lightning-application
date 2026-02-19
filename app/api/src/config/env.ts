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
    // Set to "true" to enable the automated circular rebalance scheduler (default: off)
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
    // Minimum minutes between two successful automated rebalances
    rebalanceCooldownMinutes: Number(process.env.REBALANCE_COOLDOWN_MINUTES ?? "30"),
};
