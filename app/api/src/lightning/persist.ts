import { db } from "../db";
import { getLndInfo, isLndAvailable } from "./lnd";
import { ENV } from "../config/env";

export async function persistNodeInfo(
  hasTreasuryChannel: boolean = false,
  membershipStatus: string = "unsynced"
) {
  if (!isLndAvailable()) return;

  const info = await getLndInfo();
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO lnd_node_info
    (id, pubkey, alias, network, block_height, synced_to_chain, has_treasury_channel, membership_status, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    info.synced_to_chain ? 1 : 0,
    hasTreasuryChannel ? 1 : 0,
    membershipStatus,
    now
  );

  db.prepare(`
    INSERT INTO lnd_node_info_history
    (pubkey, alias, network, block_height, synced_to_chain, has_treasury_channel, membership_status, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.public_key,
    info.alias ?? null,
    ENV.bitcoinNetwork,
    info.block_height ?? null,
    info.synced_to_chain ? 1 : 0,
    hasTreasuryChannel ? 1 : 0,
    membershipStatus,
    now
  );
}
