// GET /api/swaps/options?direction=loop_out|loop_in — Withdraw's and Top Up's
// option cards (drive-mode P3, plan item 4; spec §3.3 "Withdraw and Top Up
// options"; the record :54, R11(6), R25, R32, R16(3)).
//
// ─── READ ONLY ──────────────────────────────────────────────────────────────
// Raw loopd quotes (getLoopOutQuote / getLoopInQuote), which write NO
// swap_requests row — createLoopOutQuote would INSERT a quote_created row that
// dailyUsed then counts. No route probe. Quotes are cached ~60 s per amount so
// a page load does not cost 1–3 RPCs every time (R40). A card only PRE-FILLS
// the existing quote-then-confirm flow; nothing here starts a swap.
//
// ─── THE CARDS ──────────────────────────────────────────────────────────────
// Farmer (Withdraw): "now" — move it all, at the QUOTE-BASED MAXIMUM (R25):
//   start from available_now, take off the quoted fee, re-quote there, and
//   confirm amount + fee ≤ room to send − the swap buffer, which is what
//   execute re-checks — and one wait card: a bigger transfer later (room above
//   the floor) or calm fees (room at the floor). No small-move card (R10(3)).
//   Nothing movable → no cards, one honest sentence.
// Merchant (Top Up): two cards always (R11(6)). "now" tops up to the
//   Keep-room-open level − room to send (R32, R16(3)) — at least Loop's
//   minimum — capped by room to receive and what the wallet allows; a wallet
//   too low gives "deposit bitcoin first" + "wait".
//
// ─── EXACTLY ONE RECOMMENDED (D3.3) ─────────────────────────────────────────
// Inputs: room against the strategy's floor (Manual only uses Save on fees'
// floor, R21(1)); the quote's fee against the member's fee limit; calm. Room
// at or below the floor recommends "now" whatever the fees. Calm is "unknown"
// until 7 days of samples (R40(8)); then no reason claims fees are low or high.

import type { IncomingMessage } from "http";
import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { capacityOf } from "../lightning/capacity";
import { getHubChannel, getHubChannelForDisplay } from "../lightning/hubChannel";
import { getLoopInQuote, getLoopOutQuote } from "../lightning/loop";
import { getBtcUsd } from "../price/btcUsdCache";
import { calmReading } from "../transfers/feeSamples";
import { usdCentsToSats } from "../transfers/minimumConnection";
import { effectiveTransferSettings, memberRole, readStoredTransferSettings, STRATEGY_FLOORS_USD_CENTS, type TransferStrategy } from "../transfers/transferSettings";
import { getMemberSwapLimits } from "./swapLimits";

export type CardKey = "now" | "wait_bigger" | "wait_calm" | "wait_lower" | "deposit_first" | "wait";
export type ReasonCode =
  | "room_low" | "fees_low" | "fees_high" | "over_fee_limit" | "bigger_share" | "keep_room_open"
  | "plenty_ready" | "enough_ready" | "wallet_low";

export type OptionCard = {
  key: CardKey;
  amount_sats: number | null;
  fee_sats: number | null;
  over_fee_limit: boolean;
  recommended: boolean;
};

export type SwapOptions = {
  direction: "loop_out" | "loop_in";
  state: "ok" | "connection_down" | "no_hub_channel" | "nothing_movable" | "daily_limit" | "unavailable";
  strategy: TransferStrategy;
  floor_sats: number | null;
  room_sats: number | null;
  calm: "calm" | "not_calm" | "unknown";
  min_sats: number;
  /** Farmer, nothing movable: the minimum plus what always stays — the honest
   *  line's "once … is waiting". */
  trigger_sats: number | null;
  quote_state: "ok" | "unavailable" | "not_needed";
  /** false when there is no BTC/USD rate: the fee limit is a dollar figure,
   *  so no card can be checked against it, and none is flagged (R59(2)). */
  fee_limit_checked: boolean;
  cards: OptionCard[];
  reason: ReasonCode | null;
};

// ─── The ~60 s quote cache (R40) ────────────────────────────────────────────

export const QUOTE_CACHE_MS = 60_000;
type CachedFee = { fee: number; at: number };
const cache = new Map<string, CachedFee>();

export function clearSwapOptionsQuoteCache(): void {
  cache.clear();
}

/** The fee execute will charge against room / the fee limit, for an amount:
 *  Loop Out swap + sweep miner fee (the prepay is an advance on the principal,
 *  not a fee — as quoted_fee_sat stores it); Loop In swap + HTLC publish fee.
 *  null when loopd can't quote (or, for Loop In, can't estimate its fee). */
async function quotedFee(direction: "loop_out" | "loop_in", amount: number, now: number): Promise<number | null> {
  const key = `${direction}:${amount}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < QUOTE_CACHE_MS) return hit.fee;
  try {
    let fee: number | null;
    if (direction === "loop_out") {
      const q = await getLoopOutQuote(amount);
      fee = q.swap_fee_sat + q.miner_fee;
    } else {
      const q = await getLoopInQuote(amount, undefined, ENV.treasuryPubkey || undefined);
      fee = q.htlc_publish_fee_sat == null || !(q.htlc_publish_fee_sat > 0) ? null : q.swap_fee_sat + q.htlc_publish_fee_sat;
    }
    if (fee == null) return null;
    for (const [k, v] of cache) if (now - v.at >= QUOTE_CACHE_MS) cache.delete(k);
    cache.set(key, { fee, at: now });
    return fee;
  } catch {
    return null;
  }
}

/**
 * R25's quote-based maximum: the largest amount, at most `availableNow`, with
 * amount + its quoted fee ≤ `spendable` (room to send − the swap buffer, as
 * execute checks). At most three quotes. null when loopd can't quote; an
 * amount below `min` when today's fees leave less than the minimum.
 */
export async function quoteBasedMax(
  availableNow: number, spendable: number, min: number, now: number,
): Promise<{ amount: number; fee: number } | null> {
  let amount = availableNow;
  for (let i = 0; i < 3; i++) {
    const fee = await quotedFee("loop_out", amount, now);
    if (fee == null) return null;
    if (amount + fee <= spendable) return { amount, fee };
    const next = spendable - fee;
    if (next < min) return { amount: next, fee };
    amount = next;
  }
  return null; // did not settle in three quotes: offer no Max rather than a refusable one
}

/** The member's fee limit in sats: the one dollar figure (R48) at the rate.
 *  null with no rate — then it can't be checked, and a card is not flagged
 *  (R59(2)). */
export function feeLimitSats(usdCents: number, usdPerBtc: number | null): number | null {
  return usdPerBtc != null ? usdCentsToSats(usdCents, usdPerBtc) : null;
}

export async function getSwapOptions(direction: "loop_out" | "loop_in", nodePubkey: string, now = Date.now()): Promise<SwapOptions> {
  // The fee limit's default follows the member's channel_role (R59(3)), not
  // the swap's direction; the floors below still follow the direction.
  const settings = effectiveTransferSettings(readStoredTransferSettings(), memberRole());
  const strategy = settings.strategy;
  const usd = getBtcUsd(now).usd;
  const role = direction === "loop_out" ? "farmer" : "merchant";
  const floorKey = strategy === "open" ? "open" : "save";
  const floorSats = usd != null ? usdCentsToSats(STRATEGY_FLOORS_USD_CENTS[role][floorKey], usd) : null;
  const calm = calmReading(now).state;
  const limits = await getMemberSwapLimits(nodePubkey);
  const dir = direction === "loop_out" ? limits.loop_out : limits.loop_in;
  const min = dir.min_sats;
  const base = { direction, strategy, floor_sats: floorSats, calm, min_sats: min, trigger_sats: null, fee_limit_checked: usd != null };

  const hub = getHubChannel();
  if (!hub) {
    const shown = getHubChannelForDisplay();
    return { ...base, state: shown ? "connection_down" : "no_hub_channel", room_sats: null, quote_state: "not_needed", cards: [], reason: null };
  }
  const cap = capacityOf(hub);
  const limitSats = feeLimitSats(settings.fee_limit_usd_cents, usd);
  const overLimit = (fee: number | null) => fee != null && limitSats != null && fee > limitSats;
  const card = (key: CardKey, amount: number | null, fee: number | null): OptionCard =>
    ({ key, amount_sats: amount, fee_sats: fee, over_fee_limit: amount != null && overLimit(fee), recommended: false });
  const finish = (cards: OptionCard[], rec: CardKey, reason: ReasonCode, quote_state: SwapOptions["quote_state"], room: number): SwapOptions => {
    for (const c of cards) c.recommended = c.key === rec;
    return { ...base, state: "ok", room_sats: room, quote_state, cards, reason };
  };

  if (direction === "loop_out") {
    const room = cap.room_to_receive_sats;
    const availableNow = limits.loop_out.available_now_sats;
    const stays = limits.loop_out.always_stays;
    if (availableNow < min) {
      const dailyBinds = limits.loop_out.daily_remaining_sats < min;
      return {
        ...base, state: dailyBinds ? "daily_limit" : "nothing_movable", room_sats: room, quote_state: "not_needed", cards: [], reason: null,
        trigger_sats: !dailyBinds && stays ? min + stays.total_sats : null,
      };
    }
    const spendable = Math.max(0, cap.room_to_send_sats - ENV.swapMemberRoutingBufferSat);
    const max = await quoteBasedMax(availableNow, spendable, min, now);
    if (max && max.amount < min) {
      // Today's fees leave less than Loop's minimum: nothing to offer.
      return { ...base, state: "nothing_movable", room_sats: room, quote_state: "ok", cards: [], reason: null, trigger_sats: stays ? min + stays.total_sats : null };
    }
    const now$ = card("now", max?.amount ?? availableNow, max?.fee ?? null);
    const atFloor = floorSats != null && room <= floorSats;
    // The bigger transfer: what could move once room to receive has fallen to
    // the floor — room to send grows by (room − floor). No rate, no floor, no
    // figure.
    const wait = atFloor
      ? card("wait_calm", null, null)
      : card("wait_bigger", floorSats != null
          ? Math.min(limits.loop_out.max_sats, cap.room_to_send_sats + (room - floorSats) - ENV.swapMemberRoutingBufferSat)
          : null, null);
    let rec: CardKey, reason: ReasonCode;
    if (atFloor) { rec = "now"; reason = "room_low"; }
    else if (now$.over_fee_limit) { rec = wait.key; reason = "over_fee_limit"; }
    else if (calm === "calm") { rec = "now"; reason = "fees_low"; }
    else if (calm === "not_calm") { rec = wait.key; reason = "fees_high"; }
    else if (strategy === "open") { rec = "now"; reason = "keep_room_open"; }
    else { rec = wait.key; reason = "bigger_share"; }
    return finish([now$, wait], rec, reason, max ? "ok" : "unavailable", room);
  }

  // ── Top Up (merchant) ──
  const room = cap.room_to_send_sats;
  if (limits.loop_in.available_now_sats == null) {
    // The wallet or fee-rate read failed: unknown, not "too low".
    return { ...base, state: "unavailable", room_sats: room, quote_state: "not_needed", cards: [], reason: null };
  }
  const walletNow = limits.loop_in.available_now_sats;
  const ceiling = Math.min(walletNow, cap.room_to_receive_sats);
  const levelSats = usd != null ? usdCentsToSats(STRATEGY_FLOORS_USD_CENTS.merchant.open, usd) : null;
  if (walletNow < min) {
    return finish([card("deposit_first", null, null), card("wait", null, null)], "deposit_first", "wallet_low", "not_needed", room);
  }
  // R32 / R16(3): up to the Keep-room-open level; at least Loop's minimum.
  const target = levelSats != null ? Math.max(min, levelSats - room) : min;
  const amount = Math.min(target, ceiling);
  if (amount < min) {
    // The connection can't take Loop's smallest top-up right now.
    return { ...base, state: "nothing_movable", room_sats: room, quote_state: "not_needed", cards: [], reason: null };
  }
  const fee = await quotedFee("loop_in", amount, now);
  const top = card("now", amount, fee);
  const atFloor = floorSats != null && room <= floorSats;
  const aboveLevel = levelSats != null && room >= levelSats;
  const wait = card(!aboveLevel && calm === "not_calm" ? "wait_calm" : "wait_lower", null, null);
  let rec: CardKey, reason: ReasonCode;
  if (atFloor) { rec = "now"; reason = "room_low"; }
  else if (aboveLevel) { rec = wait.key; reason = "plenty_ready"; }
  else if (top.over_fee_limit) { rec = wait.key; reason = "over_fee_limit"; }
  else if (calm === "calm") { rec = "now"; reason = "fees_low"; }
  else if (calm === "not_calm") { rec = wait.key; reason = "fees_high"; }
  else if (strategy === "open") { rec = "now"; reason = "keep_room_open"; }
  else { rec = wait.key; reason = "enough_ready"; }
  return finish([top, wait], rec, reason, fee != null ? "ok" : "unavailable", room);
}

export async function handleSwapOptions(req: IncomingMessage, res: { writeHead: (s: number, h?: any) => any; end: (b?: string) => any }): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const direction = url.searchParams.get("direction");
  const send = (s: number, b: unknown) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (direction !== "loop_out" && direction !== "loop_in") return send(400, { error: "direction must be loop_out or loop_in" });
  const node = getNodeInfo();
  if (!node) return send(503, { error: "node_info_unavailable" });
  send(200, await getSwapOptions(direction, node.pubkey));
}
