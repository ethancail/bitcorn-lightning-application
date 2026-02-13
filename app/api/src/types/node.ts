export type NodeRole = "treasury" | "member" | "external";

export interface NodeInfo {
  id: number;
  pubkey: string;
  alias: string;
  network: string;
  block_height: number | null;
  synced_to_chain: number;
  updated_at: number;
  has_treasury_channel: number;
  membership_status: string;
  node_role: NodeRole;
}
