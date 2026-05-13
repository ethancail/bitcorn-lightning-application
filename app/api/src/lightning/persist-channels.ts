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
    // INSERT-then-UPDATE rather than INSERT OR REPLACE so `first_seen_at`
    // (migration 041) is set exactly once per channel — the timestamp
    // of the first sync that observed this channel. Used by the
    // subscription status route to discriminate "transient: sync loop
    // hasn't allocated a row yet" from "operational anomaly: row should
    // exist by now" (spec §5.2 Case C vs D, 60s threshold).
    db.prepare(`
      INSERT INTO lnd_channels
        (channel_id, peer_pubkey, capacity_sat, local_balance_sat,
         remote_balance_sat, active, private, updated_at, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        peer_pubkey = excluded.peer_pubkey,
        capacity_sat = excluded.capacity_sat,
        local_balance_sat = excluded.local_balance_sat,
        remote_balance_sat = excluded.remote_balance_sat,
        active = excluded.active,
        private = excluded.private,
        updated_at = excluded.updated_at
    `).run(
      c.id,
      c.partner_public_key,
      c.capacity,
      c.local_balance,
      c.remote_balance,
      c.is_active ? 1 : 0,
      c.is_private ? 1 : 0,
      now,
      now,  // first_seen_at — preserved on conflict via the ON CONFLICT clause omitting this column
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
