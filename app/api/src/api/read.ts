import { db } from "../db";

export function getNodeInfo() {
  return db
    .prepare("SELECT * FROM lnd_node_info WHERE id = 1")
    .get() ?? null;
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
