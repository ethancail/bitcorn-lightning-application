// Liquidity page — role-aware peer health types and constants.

export type LiquidityRole = "merchant" | "farmer" | "external" | "unknown";

export type HealthTier = "critical" | "heavy" | "healthy" | "neutral";

export type LiquidityPeer = {
  pubkey: string;
  name: string;
  role: LiquidityRole;
  capacity: number;          // sum across channels, sats
  memberLocal: number;       // sum of treasury-remote across channels (= member's local)
  memberRemote: number;      // sum of treasury-local across channels (= member's remote)
  channelCount: number;
  // role-aware metric: send% for merchants, receive% for farmers, null for external/unknown
  rolePct: number | null;
  healthTier: HealthTier;
};

// Health thresholds (matches member-side advisor's heavy/saturated bands).
export const HEALTH_CRITICAL_MAX = 0.15; // <15% → critical
export const HEALTH_HEAVY_MAX    = 0.30; // 15-30% → heavy; ≥30% → healthy

// Role color tokens — values are CSS-var strings so theme switches cascade.
export const ROLE_COLOR: Record<LiquidityRole, string> = {
  merchant: "var(--amber)",
  farmer:   "var(--green)",
  external: "var(--blue)",
  unknown:  "var(--text-3)",
};

// Health color tokens — same pattern.
export const HEALTH_COLOR: Record<HealthTier, string> = {
  critical: "var(--red)",
  heavy:    "var(--amber)",
  healthy:  "var(--green)",
  neutral:  "var(--text-3)",
};

// Hard-coded external pubkeys (mirrors NetworkGraph.tsx today). ACINQ.
export const EXTERNAL_PUBKEYS = new Set([
  "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
]);
