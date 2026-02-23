import { db } from "../db";
import { getLndChannels, getLndPeers } from "./lnd";

export async function persistPeers() {
  const { peers } = await getLndPeers();
  const now = Date.now();

  for (const p of peers ?? []) {
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
}

export async function persistChannels() {
  const { channels } = await getLndChannels();
  const now = Date.now();

  for (const c of channels ?? []) {
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
}
