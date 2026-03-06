import { db } from "../db";
import { getLndChannels, getLndPeers } from "./lnd";

export async function persistPeers() {
  const { peers } = await getLndPeers();
  const now = Date.now();
  const currentPubkeys: string[] = [];

  for (const p of peers ?? []) {
    currentPubkeys.push(p.public_key);
    db.prepare(`
      INSERT OR REPLACE INTO lnd_peers
      (pubkey, address, bytes_sent, bytes_received, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      p.public_key,
      p.socket ?? null,
      p.bytes_sent ?? 0,
      p.bytes_received ?? 0,
      now
    );
  }

  // Remove disconnected peers no longer returned by LND
  if (currentPubkeys.length > 0) {
    const placeholders = currentPubkeys.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM lnd_peers WHERE pubkey NOT IN (${placeholders})`
    ).run(...currentPubkeys);
  } else {
    db.prepare(`DELETE FROM lnd_peers`).run();
  }
}

export async function persistChannels() {
  const { channels } = await getLndChannels();
  const now = Date.now();
  const currentIds: string[] = [];

  for (const c of channels ?? []) {
    currentIds.push(c.id);
    db.prepare(`
      INSERT OR REPLACE INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat,
       remote_balance_sat, active, private, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id,
      c.partner_public_key,
      c.capacity,
      c.local_balance,
      c.remote_balance,
      c.is_active ? 1 : 0,
      c.is_private ? 1 : 0,
      now
    );
  }

  // Remove closed channels no longer returned by LND
  if (currentIds.length > 0) {
    const placeholders = currentIds.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM lnd_channels WHERE channel_id NOT IN (${placeholders})`
    ).run(...currentIds);
  } else {
    db.prepare(`DELETE FROM lnd_channels`).run();
  }
}
