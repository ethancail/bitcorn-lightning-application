// Environment variable configuration and validation
export const ENV = {
    isDev: process.env.NODE_ENV !== "production",
    debug: process.env.DEBUG === "1" || process.env.DEBUG === "true",
    bitcoinNetwork: process.env.BITCOIN_NETWORK || "mainnet",
    lndGrpcHost: process.env.LND_GRPC_HOST || "lightning_lnd_1:10009",
    treasuryPubkey: process.env.TREASURY_PUBKEY || "",
    rateLimitTxPerMinute: parseInt(process.env.RATE_LIMIT_TX_PER_MINUTE || "5", 10),
    rateLimitSatsPerMinute: parseInt(process.env.RATE_LIMIT_SATS_PER_MINUTE || "100000", 10),
    rateLimitSatsPerHour: parseInt(process.env.RATE_LIMIT_SATS_PER_HOUR || "1000000", 10),
    rateLimitMaxSinglePayment: parseInt(process.env.RATE_LIMIT_MAX_SINGLE_PAYMENT || "250000", 10),

    rebalanceMinIncomingRemoteRatioPpm: Number(
        process.env.REBALANCE_MIN_INCOMING_REMOTE_RATIO_PPM ?? "200000"
    ),
    rebalanceMinOutgoingLocalRatioPpm: Number(
        process.env.REBALANCE_MIN_OUTGOING_LOCAL_RATIO_PPM ?? "200000"
    ),
    rebalanceSafetyBufferSats: Number(process.env.REBALANCE_SAFETY_BUFFER_SATS ?? "1000"),

    rebalanceSchedulerEnabled: process.env.REBALANCE_SCHEDULER_ENABLED === "true",
    rebalanceSchedulerIntervalMs: Number(
        process.env.REBALANCE_SCHEDULER_INTERVAL_MS ?? "60000"
    ),
    rebalanceDefaultTokens: Number(process.env.REBALANCE_DEFAULT_TOKENS ?? "5000"),
    rebalanceMaxTokens: Number(process.env.REBALANCE_MAX_TOKENS ?? "25000"),
    rebalanceDefaultMaxFeeSats: Number(
        process.env.REBALANCE_DEFAULT_MAX_FEE_SATS ?? "10"
    ),
    rebalanceCooldownMinutes: Number(process.env.REBALANCE_COOLDOWN_MINUTES ?? "30"),
};