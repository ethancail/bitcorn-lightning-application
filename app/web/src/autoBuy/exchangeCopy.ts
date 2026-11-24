// The exchange's name and hold, as Auto-Buy copy words them (kraken-autobuy P6).
//
// · NAME (D-P6-1, D-P6-6): "kraken" reads as Kraken; anything else, including
//   a missing value, reads as Coinbase. A missing provider means Coinbase by
//   construction: the API adds provider "kraken" to an alert raised on Kraken
//   and leaves Coinbase's alert contexts as they always were.
// · HOLD (D-P6-2): the length comes from the API (status.config.hold_seconds,
//   or a run's hold_ends_at − filled_at), never from a web constant. 96 hours
//   or more is worded in days ("7-day"), less in hours ("72-hour"). Unknown
//   reads as null, and the caller leaves the length out.

import type { AutoBuyProvider } from "../api/client";

export type ExchangeName = "Coinbase" | "Kraken";

export function exchangeName(provider: AutoBuyProvider | string | null | undefined): ExchangeName {
  return provider === "kraken" ? "Kraken" : "Coinbase";
}

export function holdLabel(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const hours = Math.round(seconds / 3600);
  return hours >= 96 ? `${Math.round(hours / 24)}-day` : `${hours}-hour`;
}

/** The same length as a noun ("72 hours", "7 days"), for "… later" sentences. Null when unknown. */
export function holdDuration(seconds: number | null | undefined): string | null {
  const label = holdLabel(seconds);
  if (!label) return null;
  const [n, unit] = label.split("-");
  return `${n} ${unit}${n === "1" ? "" : "s"}`;
}

/** A run's hold length, from the API's hold end and the run's fill time. */
export function runHoldLabel(run: { filled_at?: number | null; hold_ends_at: number | null }): string | null {
  if (run.hold_ends_at == null || run.filled_at == null) return null;
  return holdLabel(run.hold_ends_at - run.filled_at);
}
