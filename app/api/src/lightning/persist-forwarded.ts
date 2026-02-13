import { db } from "../db";
import { getLndForwards, isLndAvailable } from "./lnd";

/**
 * Syncs LND forwarding history into payments_forwarded.
 * Paginates through getForwards and inserts new rows (UNIQUE on
 * incoming_channel, outgoing_channel, created_at).
 */
export async function syncForwardingHistory(): Promise<void> {
  if (!isLndAvailable()) return;

  let token: string | undefined;
  const limit = 100;

  do {
    const page = await getLndForwards({ limit, token });
    for (const f of page.forwards) {
      const createdAt = f.created_at
        ? new Date(f.created_at).getTime()
        : Date.now();
      try {
        db.prepare(`
          INSERT OR IGNORE INTO payments_forwarded
          (incoming_channel, outgoing_channel, tokens, fee, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          f.incoming_channel,
          f.outgoing_channel,
          f.tokens ?? 0,
          f.fee ?? 0,
          createdAt
        );
      } catch (err) {
        console.error(
          `[forwarded] Failed to insert forward ${f.incoming_channel}/${f.outgoing_channel} @ ${f.created_at}:`,
          err
        );
      }
    }
    token = page.next;
  } while (token);
}
