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
  // `lib/jwt.ts` to validate JWTs on gated endpoints. Unset → gated
  // endpoints return 503.
  SUBSCRIPTION_PUBLIC_KEY?: string;
  // Treasury HTTP API URL surfaced via /treasury-info for member-node
  // token-refresh discovery. Set by the treasury operator via
  // `wrangler secret put TREASURY_API_URL` to e.g.
  // http://<treasury-tailnet-ip>:3101. Members fall back to this when
  // their local TREASURY_API_URL env var is unset — solves the Stage 4
  // distribution gap (operators can't SSH into customer-owned Umbrels
  // to set the env var per-member).
  TREASURY_API_URL?: string;
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
