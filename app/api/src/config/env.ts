// Environment variable configuration and validation
export const ENV = {
    isDev: process.env.NODE_ENV !== "production",
    bitcoinNetwork: process.env.BITCOIN_NETWORK || "mainnet",
    lndGrpcHost: process.env.LND_GRPC_HOST || "lightning_lnd_1:10009",
};