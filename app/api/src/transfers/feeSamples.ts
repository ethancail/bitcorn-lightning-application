// Fee-estimate samples and "calm" (drive-mode P3, R40(8); spec §3.1
// "Fee-estimate samples"; R15(5)).
//
// R15(5): calm means the next-6-block fee estimate is at or below its 7-day
// median. lnd gives a point estimate only and nothing stored fee history, so
// the median was not computable. P3 starts collecting it — READ ONLY: one
// getChainFeeRate call at most every 10 minutes, off the existing sync tick,
// kept 8 days — so that calm has 7 days of history by P4.
//
// Until the samples span 7 days, calm is "unknown", and nothing may say fees
// are low. Nothing here starts a transfer or a payment.

import { db } from "../db";
import { getLndChainFeeRate } from "../lightning/lnd";

export const SAMPLE_INTERVAL_MS = 10 * 60_000;
export const KEEP_MS = 8 * 86_400_000;
export const CALM_WINDOW_MS = 7 * 86_400_000;
/** The latest sample stands for "the current estimate" only while this fresh:
 *  two missed sample slots and the reading is unknown. */
export const CURRENT_MAX_AGE_MS = 2 * SAMPLE_INTERVAL_MS;
export const CONF_TARGET = 6;

/**
 * Take one sample if the last is at least SAMPLE_INTERVAL_MS old, and drop
 * samples older than KEEP_MS. A failed read records nothing and is not
 * retried before the next tick. Returns whether a sample was stored.
 */
export async function maybeSampleFeeEstimate(
  now = Date.now(),
  read: () => Promise<{ tokens_per_vbyte: number }> = () => getLndChainFeeRate(CONF_TARGET),
): Promise<boolean> {
  const last = db.prepare("SELECT MAX(sampled_at) AS t FROM fee_estimate_samples").get() as { t: number | null };
  if (last.t != null && now - last.t < SAMPLE_INTERVAL_MS) return false;
  let rate: number;
  try {
    rate = (await read()).tokens_per_vbyte;
  } catch (err: any) {
    console.warn("[feeSamples] estimate unavailable:", err?.message ?? String(err));
    return false;
  }
  if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) return false;
  db.prepare("INSERT INTO fee_estimate_samples (sampled_at, sat_per_vbyte) VALUES (?, ?)").run(now, rate);
  db.prepare("DELETE FROM fee_estimate_samples WHERE sampled_at < ?").run(now - KEEP_MS);
  return true;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type CalmReading =
  | { state: "unknown"; reason: "not_enough_history" | "no_current_estimate"; estimate: number | null; median: null; history_ms: number }
  | { state: "calm" | "not_calm"; estimate: number; median: number; history_ms: number };

/** R15(5)'s reading, from the stored samples. */
export function calmReading(now = Date.now()): CalmReading {
  const rows = db.prepare(
    "SELECT sampled_at, sat_per_vbyte FROM fee_estimate_samples WHERE sampled_at <= ? ORDER BY sampled_at",
  ).all(now) as Array<{ sampled_at: number; sat_per_vbyte: number }>;
  const history_ms = rows.length ? now - rows[0].sampled_at : 0;
  const latest = rows[rows.length - 1];
  const estimate = latest && now - latest.sampled_at <= CURRENT_MAX_AGE_MS ? latest.sat_per_vbyte : null;
  if (history_ms < CALM_WINDOW_MS) return { state: "unknown", reason: "not_enough_history", estimate, median: null, history_ms };
  if (estimate == null) return { state: "unknown", reason: "no_current_estimate", estimate: null, median: null, history_ms };
  const window = rows.filter((r) => r.sampled_at >= now - CALM_WINDOW_MS).map((r) => r.sat_per_vbyte);
  const med = median(window);
  return { state: estimate <= med ? "calm" : "not_calm", estimate, median: med, history_ms };
}
