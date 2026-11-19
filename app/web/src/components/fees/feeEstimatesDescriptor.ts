// fee-estimates — the words and the pure rules shared by the three
// confirmation-speed cards: the member's Connect card, the treasury's New
// Channel panel and its Close dialog. Spec:
// bitcorn-research specs/2026-11-16-fee-estimates-live-rates-and-times-spec.md.
//
// Every figure comes from GET /api/fee-estimates; nothing here is a fee.
// member-first-run-ui reviews every string below before merge (spec §15).

import type { FeeEstimateOption, FeeEstimates, FeeOptionKey } from "../../api/client";
import { formatSats, formatUsd } from "../amount/amountDescriptor";

/** The cards' order, and the reset target (F3: state holds the KEY; reset is to Economy). */
export const FEE_OPTION_ORDER: readonly FeeOptionKey[] = ["economy", "normal", "priority"];
export const DEFAULT_FEE_OPTION: FeeOptionKey = "economy";

export const FEE_OPTION_LABEL: Record<FeeOptionKey, string> = {
  economy: "Economy",
  normal: "Normal",
  priority: "Priority",
};

/** P18 (a): the bound on the time since the card fetched the estimate, checked at confirm. */
export const CONFIRM_STALE_AFTER_MS = 10 * 60 * 1000;
/** P2 / P18: the refresh interval while a card is open. */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** P18: the data's age is shown beside the figures from this age on (P10 governs up to 30 min). */
export const SHOW_DATA_AGE_FROM_MS = 10 * 60 * 1000;

export const FEE_COPY = {
  /** O7: no figure, submit blocked. */
  unavailable: "Fee estimate unavailable",
  /** P15 (a): the option shows its figure, blocked, with the ceiling as the reason. */
  aboveCeiling: (ceiling: number) => `Above the ${ceiling} sat/vB limit — wait for fees to fall`,
  /** D6 ruling: LND refused the rate as below this node's relay floor. */
  tooLowForNetwork: "This rate is too low for the network right now — choose a faster option.",
  /** P18: shown beside the figures when the data is 10 min old or more. */
  dataAge: (minutes: number) => `Rates from ${minutes} min ago`,
  /** O6: the estimate was refreshed at confirm; nothing was sent. The treasury's modals. */
  refreshed: "The fee estimate was refreshed — check the new rate and confirm again.",
  /** O6, member-facing (Ethan, "recs" via member-first-run-ui, 2026-11-18): the
   *  new fee in FeeCost's format, "about $X (N sats)"; sats alone with no price. */
  memberReshow: (sats: number, usdPerBtc: number | null) => ({
    heading: "Fee updated",
    body: `Network fees changed while this was open. The new fee is ${
      usdPerBtc != null ? `about ${formatUsd(sats, usdPerBtc).text} (${formatSats(sats)})` : `about ${formatSats(sats)}`
    }. Type the amount again to confirm.`,
  }),
  /** R2: a cooperative close's rate is an offer to the peer. */
  closeRateHeading: "Fee rate proposed to the peer",
  /** D3 / R2: the close cost's qualifier, after FeeCost's figure: "about $X
   *  proposed — the final fee is often higher" (ruling 4 of member-first-run-ui's
   *  review, 2026-11-18; it replaced "about $X, if accepted"). With no price,
   *  FeeCost's sats fallback: "~N sats proposed — the final fee is often higher". */
  closeCostQualifier: "proposed — the final fee is often higher",
  /** R3: interim payer wording until Q8's config half is read. */
  closePayer: "The fee is paid by whoever opened the channel.",
};

/** P12: rounded ranges, arithmetic on block intervals; "estimate" under the LND fallback (O1). */
export function timeText(o: Pick<FeeEstimateOption, "time_minutes" | "estimate">): string {
  const range = `about ${o.time_minutes.min}–${o.time_minutes.max} min`;
  return o.estimate ? `${range} · estimate` : range;
}

/** The options in card order, or null when there is no figure to show (O7). */
export function feeOptions(est: FeeEstimates | null): FeeEstimateOption[] | null {
  if (!est || est.source === "unavailable" || !est.options) return null;
  return FEE_OPTION_ORDER.map((k) => est.options![k]);
}

/** P15: an option above the ceiling is blocked. */
export function isAboveCeiling(est: FeeEstimates, o: FeeEstimateOption): boolean {
  return o.rate > est.ceiling_sat_per_vbyte;
}

/** P19: the Technical Details row — the live integer rates from the same answer. */
export function ratesDetail(est: FeeEstimates | null): string {
  const opts = feeOptions(est);
  if (!opts) return FEE_COPY.unavailable;
  return opts.map((o) => `${FEE_OPTION_LABEL[o.key]} ~${o.rate} sat/vB`).join(" · ");
}

/**
 * The data's age in minutes now, or null below SHOW_DATA_AGE_FROM_MS: the API's
 * age at the card's fetch plus the time since the card fetched it.
 */
export function shownDataAgeMinutes(est: FeeEstimates | null, fetchedAtMs: number | null, nowMs: number): number | null {
  if (!est || est.data_age_seconds == null || fetchedAtMs == null) return null;
  const ageMs = est.data_age_seconds * 1000 + (nowMs - fetchedAtMs);
  return ageMs >= SHOW_DATA_AGE_FROM_MS ? Math.floor(ageMs / 60_000) : null;
}
