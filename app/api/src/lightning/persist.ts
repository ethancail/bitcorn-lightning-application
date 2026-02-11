import { db } from "../db";
import { getLndInfo, isLndAvailable } from "./lnd";
import { ENV } from "../config/env";

export async function persistNodeInfo() {
  if (!isLndAvailable()) return;

  const info = await getLndInfo();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO lnd_node_info
    (id, pubkey, alias, network, block_height, synced_to_chain, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    0, // synced_to_chain: derive later
    now
  );

  db.prepare(`
    INSERT INTO lnd_node_info_history
    (pubkey, alias, network, block_height, synced_to_chain, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    0, // synced_to_chain: derive later
    now
  );
}
