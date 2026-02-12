import { db } from "../db";
import { getLndInfo, isLndAvailable } from "./lnd";
import { ENV } from "../config/env";

export async function persistNodeInfo(hasTreasuryChannel: boolean = false) {
  if (!isLndAvailable()) return;

  const info = await getLndInfo();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO lnd_node_info
    (id, pubkey, alias, network, block_height, synced_to_chain, block_drift, has_treasury_channel, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    info.synced_to_chain ? 1 : 0,
    info.block_drift ?? null,
    hasTreasuryChannel ? 1 : 0,
    now
  );

  db.prepare(`
    INSERT INTO lnd_node_info_history
    (pubkey, alias, network, block_height, synced_to_chain, block_drift, has_treasury_channel, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    info.synced_to_chain ? 1 : 0,
    info.block_drift ?? null,
    hasTreasuryChannel ? 1 : 0,
    now
  );
}
