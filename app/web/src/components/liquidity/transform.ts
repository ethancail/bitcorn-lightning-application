import { resolveContactName, type Contact } from "../../api/client";
import {
  EXTERNAL_PUBKEYS,
  HEALTH_CRITICAL_MAX,
  HEALTH_HEAVY_MAX,
  type HealthTier,
  type LiquidityPeer,
  type LiquidityRole,
} from "./types";

export type ChannelData = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
};

function classifyRole(pubkey: string, contact: Contact | undefined): LiquidityRole {
  const tags = (contact?.tags ?? []).map((t) => t.toLowerCase());
  // Accept the short tag (`external`) and the lane-purpose name
  // (`external-peer`) as equivalent. Same for merchant / farmer.
  if (EXTERNAL_PUBKEYS.has(pubkey) || tags.includes("external") || tags.includes("external-peer")) return "external";
  if (tags.includes("merchant") || tags.includes("merchant-lane")) return "merchant";
  if (tags.includes("farmer") || tags.includes("farmer-lane")) return "farmer";
  return "unknown";
}

export function classifyHealthTier(role: LiquidityRole, rolePct: number | null): HealthTier {
  if (role === "external" || role === "unknown" || rolePct === null) return "neutral";
  if (rolePct < HEALTH_CRITICAL_MAX) return "critical";
  if (rolePct < HEALTH_HEAVY_MAX) return "heavy";
  return "healthy";
}

export function buildLiquidityPeers(
  channels: ChannelData[],
  contacts: Contact[],
): LiquidityPeer[] {
  const peerMap = new Map<string, ChannelData[]>();
  for (const ch of channels) {
    if (!peerMap.has(ch.peer_pubkey)) peerMap.set(ch.peer_pubkey, []);
    peerMap.get(ch.peer_pubkey)!.push(ch);
  }

  const peers: LiquidityPeer[] = [];
  for (const [pubkey, chs] of peerMap) {
    const contact = contacts.find((c) => c.pubkey === pubkey);
    const role = classifyRole(pubkey, contact);
    const capacity = chs.reduce((s, c) => s + c.capacity_sat, 0);
    const treasuryLocal = chs.reduce((s, c) => s + c.local_balance_sat, 0);
    const treasuryRemote = chs.reduce((s, c) => s + c.remote_balance_sat, 0);
    // From treasury POV: treasury_local = member_remote, treasury_remote = member_local.
    const memberLocal = treasuryRemote;
    const memberRemote = treasuryLocal;

    let rolePct: number | null = null;
    if (capacity > 0) {
      if (role === "merchant") rolePct = memberLocal / capacity;
      else if (role === "farmer") rolePct = memberRemote / capacity;
    }

    peers.push({
      pubkey,
      name: resolveContactName(pubkey, contacts),
      role,
      capacity,
      memberLocal,
      memberRemote,
      channelCount: chs.length,
      rolePct,
      healthTier: classifyHealthTier(role, rolePct),
    });
  }

  return peers;
}

// Urgency-first sort: critical → heavy → healthy → neutral. Alphabetical tie-break.
export function comparePeers(a: LiquidityPeer, b: LiquidityPeer): number {
  const tierOrder: Record<HealthTier, number> = {
    critical: 0,
    heavy: 1,
    healthy: 2,
    neutral: 3,
  };
  const tierDiff = tierOrder[a.healthTier] - tierOrder[b.healthTier];
  if (tierDiff !== 0) return tierDiff;
  return a.name.localeCompare(b.name);
}

// Short-format a sats number: "320k", "1.2M", "850" for sub-1000.
export function formatSatsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

export type LiquidityKpis = {
  totalDeployed: number;
  peerCount: number;
  merchantsHealthy: number;
  merchantsTotal: number;
  merchantsTier: HealthTier; // overall tier — lowest among merchants
  farmersHealthy: number;
  farmersTotal: number;
  farmersTier: HealthTier;
};

function aggregateTier(peers: LiquidityPeer[]): HealthTier {
  if (peers.some((p) => p.healthTier === "critical")) return "critical";
  if (peers.some((p) => p.healthTier === "heavy")) return "heavy";
  if (peers.length === 0) return "neutral";
  return "healthy";
}

export function computeKpis(peers: LiquidityPeer[]): LiquidityKpis {
  const merchants = peers.filter((p) => p.role === "merchant");
  const farmers = peers.filter((p) => p.role === "farmer");
  return {
    totalDeployed: peers.reduce((s, p) => s + p.capacity, 0),
    peerCount: peers.length,
    merchantsHealthy: merchants.filter((p) => p.healthTier === "healthy").length,
    merchantsTotal: merchants.length,
    merchantsTier: aggregateTier(merchants),
    farmersHealthy: farmers.filter((p) => p.healthTier === "healthy").length,
    farmersTotal: farmers.length,
    farmersTier: aggregateTier(farmers),
  };
}
