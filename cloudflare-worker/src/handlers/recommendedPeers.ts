import { CORS_HEADERS } from "../lib/cors";

type RecommendedPeer = {
  id: string;
  label: string;
  pubkey: string;
  socket: string;
  description: string;
  recommended_channel_size_sat: number;
  advanced: boolean;
};

const RECOMMENDED_PEERS: RecommendedPeer[] = [
  {
    id: "acinq",
    label: "ACINQ",
    pubkey: "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
    socket: "3.33.236.230:9735",
    description:
      "Major Lightning hub and creators of Phoenix wallet. High liquidity, reliable routing.",
    recommended_channel_size_sat: 1_000_000,
    advanced: false,
  },
];

export function handleRecommendedPeers(): Response {
  return Response.json(RECOMMENDED_PEERS, { headers: CORS_HEADERS });
}
