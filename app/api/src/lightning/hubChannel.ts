// The hub channel — one definition, used by every site that names "the
// channel to the treasury" (drive-mode spec P1 item 1, D1.1).
//
// Rule (R16(5), R17(5), R18(1)–(3)):
//   - the largest ACTIVE channel to the treasury;
//   - between equal capacities, the lowest short channel ID in NUMERIC order —
//     block height, then transaction index, then output index; never text
//     order ("100x1x0" sorts before "99x5x0" as text, after it as numbers);
//   - with no active hub channel, getHubChannel() returns null: payments carry
//     no pin (C8), the Loop policy and the advisor see no channel. Only
//     getHubChannelForDisplay() (member stats) falls back to the largest
//     inactive channel, for display beside the connection-down alert.
//
// Column: lnd_channels.channel_id, which persist-channels.ts writes from
// ln-service's `id` — bolt07 chanFormat, the "BLOCKxTXxOUTPUT" text form. It
// is parsed here and compared as numbers.

import { db } from "../db";
import { ENV } from "../config/env";

export type HubChannelRow = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
  private: number;
  updated_at: number;
  local_reserve_sat: number | null;
  remote_reserve_sat: number | null;
  commit_fee_sat: number | null;
  commitment_type: string | null;
  pending_outgoing_sat: number | null;
  pending_incoming_sat: number | null;
};

/** [block, tx, output] of a "BxTxO" short channel ID, or null if malformed. */
export function parseShortChannelId(id: string): [number, number, number] | null {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(id);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric order: block, then transaction, then output. A malformed ID sorts
 *  after every well-formed one (and malformed IDs by text, for stability). */
export function compareShortChannelIds(a: string, b: string): number {
  const pa = parseShortChannelId(a);
  const pb = parseShortChannelId(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Largest capacity first, then the lowest short channel ID. */
function pick(rows: HubChannelRow[]): HubChannelRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (x, y) => y.capacity_sat - x.capacity_sat || compareShortChannelIds(x.channel_id, y.channel_id),
  )[0];
}

function hubRows(activeOnly: boolean): HubChannelRow[] {
  if (!ENV.treasuryPubkey) return [];
  return db
    .prepare(
      `SELECT * FROM lnd_channels WHERE peer_pubkey = ?${activeOnly ? " AND active = 1" : ""}`,
    )
    .all(ENV.treasuryPubkey) as HubChannelRow[];
}

/** The hub channel: the largest active channel to the treasury, or null. */
export function getHubChannel(): HubChannelRow | null {
  return pick(hubRows(true));
}

/** Member stats only (R18(2)): the hub channel, or — when none is active — the
 *  largest inactive one, for display. Never used to pin or check a payment. */
export function getHubChannelForDisplay(): HubChannelRow | null {
  return getHubChannel() ?? pick(hubRows(false));
}
