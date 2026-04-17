export interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;
  TREASURY_SOCKET?: string;
  // Valuation upstreams (added in later tasks; optional here so tests can stub)
  GLASSNODE_API_KEY?: string;
  CRYPTOQUANT_API_KEY?: string;
  LOOKINTOBITCOIN_API_KEY?: string;
  PLANB_API_KEY?: string;
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
