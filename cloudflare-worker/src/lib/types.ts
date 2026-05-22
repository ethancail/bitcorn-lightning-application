export interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;
  TREASURY_SOCKET?: string;
  // Valuation upstreams (only the auto-fetch adapters need keys now)
  CRYPTOQUANT_API_KEY?: string;
  PLANB_API_KEY?: string;
  // Manual-input HMAC (validated by POST /valuation/manual)
  VALUATION_SUBMIT_HMAC?: string;
  // Subscription entitlement-token public key (base64url of the raw
  // 32-byte Ed25519 public key, copied from the treasury's
  // `/api/admin/subscription/public-key` endpoint). Used by
  // `lib/jwt.ts` to validate JWTs on gated endpoints, and surfaced via
  // `handlers/treasuryInfo.ts` as a full JWK object so member nodes
  // can validate locally. The raw-x storage form is the Worker's
  // internal choice; the published external contract is the JWK JSON
  // shape (`{kty: "OKP", crv: "Ed25519", x: <this>}`). Unset → gated
  // endpoints return 503 and /treasury-info omits the JWK field
  // (members then fall back to cross-node JWT validation).
  SUBSCRIPTION_PUBLIC_KEY?: string;
  // Treasury HTTP API URL surfaced via /treasury-info for member-node
  // token-refresh discovery. Set by the treasury operator via
  // `wrangler secret put TREASURY_API_URL` to e.g.
  // http://<treasury-tailnet-ip>:3101. Members fall back to this when
  // their local TREASURY_API_URL env var is unset — solves the Stage 4
  // distribution gap (operators can't SSH into customer-owned Umbrels
  // to set the env var per-member).
  TREASURY_API_URL?: string;

  // ─── Stablecoin rail (BASE/USDC) per spec §5 ─────────────────────────
  // Set per-environment via `wrangler secret put` (RPC URL is secret since
  // it embeds an API key with Alchemy/Coinbase; contract addresses are
  // technically public on-chain but kept here for single-source-of-truth
  // distribution to member nodes via /base/contract-info).
  //
  //   BASE_SEPOLIA_RPC_URL              — upstream JSON-RPC endpoint
  //   SETTLEMENT_ROUTER_ADDRESS         — deployed SettlementRouter (0x...)
  //   USDC_TOKEN_ADDRESS                — USDC contract on the target chain
  //   SETTLEMENT_ROUTER_DEPLOY_BLOCK    — block where the router was deployed
  //                                       (used by §7 sync loop's starting cursor)
  //   BASE_CHAIN_ID                     — "84532" for Sepolia, "8453" for mainnet
  //
  // Unset → /base/contract-info returns rpc_status="unconfigured" and the
  // /base/contract-state + /base/balance endpoints return 503. v1 testnet
  // surfaces only the Sepolia deployment; mainnet promotion is a separate
  // wrangler-secret rotation after the §12.3 audit + memos gate clears.
  BASE_SEPOLIA_RPC_URL?: string;
  SETTLEMENT_ROUTER_ADDRESS?: string;
  USDC_TOKEN_ADDRESS?: string;
  SETTLEMENT_ROUTER_DEPLOY_BLOCK?: string;
  BASE_CHAIN_ID?: string;
}

export type CommodityPrice = {
  price: number;
  unit: string;
  label: string;
  updated_at: string;
} | null;

export type CommodityPrices = {
  gold: CommodityPrice;
  corn: CommodityPrice;
  soybeans: CommodityPrice;
  wheat: CommodityPrice;
};
