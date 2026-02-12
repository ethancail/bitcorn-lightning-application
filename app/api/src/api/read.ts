import { db } from "../db";
import { NodeInfo } from "../types/node";

export function getNodeInfo(): NodeInfo | null {
  const row = db.prepare("SELECT * FROM lnd_node_info WHERE id = 1").get();
  return row ? (row as NodeInfo) : null;
}

export function getPeers() {
  return db
    .prepare("SELECT * FROM lnd_peers ORDER BY updated_at DESC")
    .all();
}

export function getChannels() {
  return db
    .prepare("SELECT * FROM lnd_channels ORDER BY updated_at DESC")
    .all();
}
