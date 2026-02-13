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
};