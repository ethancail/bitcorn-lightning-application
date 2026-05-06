import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchBtcPriceHistory } from "./priceHistory";

// Stock-to-Flow deviation, computed locally from BTC's deterministic supply
// schedule and the daily close price series. Replaces the previous
// dependency on PlanB's external API (api.planbtc.com) which went offline.
//
// Definition: deviation = (actual_price − model_price) / model_price.
// Positive = price above the S2F-implied fair value; negative = below.
//
// Model: PlanB's published 2019 regression
//   ln(market_cap) = 3.3 × ln(SF) + 14.6
// rearranged to per-coin price:
//   model_price = exp(14.6) × SF^3.3 / supply
// The intercept and exponent are constants — we don't refit historically.
// The model has drifted bearishly post-2022, which is itself the signal:
// negative deviation captures that "BTC is cheap vs. the S2F prior."

const MODEL_LN_INTERCEPT = 14.6;
const MODEL_S2F_EXPONENT = 3.3;
const BLOCKS_PER_DAY = 144;
const DAYS_PER_YEAR = 365.25;

// Halving epochs (UTC dates of confirmed/projected halvings) and the
// post-halving block subsidy. Treated as known constants — Bitcoin's
// supply schedule is deterministic and tooling that needs more precision
// can swap in a block-height oracle later. Future entries past 2028 use
// the projected ~4-year cadence for forward extrapolation only.
const HALVINGS: ReadonlyArray<{ start: number; reward: number }> = [
  { start: dateToUnix("2009-01-03"), reward: 50 },
  { start: dateToUnix("2012-11-28"), reward: 25 },
  { start: dateToUnix("2016-07-09"), reward: 12.5 },
  { start: dateToUnix("2020-05-11"), reward: 6.25 },
  { start: dateToUnix("2024-04-19"), reward: 3.125 },
  { start: dateToUnix("2028-04-15"), reward: 1.5625 },
];

function dateToUnix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

// Total mined supply at unix-second `t`, computed as the sum of
// (epoch_days × blocks_per_day × subsidy) across each halving era up to t.
function supplyAt(t: number): number {
  let supply = 0;
  for (let i = 0; i < HALVINGS.length; i++) {
    const epochStart = HALVINGS[i].start;
    if (t <= epochStart) break;
    const epochEnd = i + 1 < HALVINGS.length ? HALVINGS[i + 1].start : Number.POSITIVE_INFINITY;
    const end = Math.min(t, epochEnd);
    const days = (end - epochStart) / 86400;
    supply += days * BLOCKS_PER_DAY * HALVINGS[i].reward;
    if (t < epochEnd) break;
  }
  return supply;
}

// Annualized issuance at unix-second `t` (BTC/yr). Used as the "flow"
// denominator. Ignores the halving boundary that may fall mid-year —
// good enough for a rolling indicator and consistent with how the
// original metric was computed upstream.
function annualIssuanceAt(t: number): number {
  let reward = 0;
  for (const h of HALVINGS) {
    if (h.start <= t) reward = h.reward;
  }
  return reward * BLOCKS_PER_DAY * DAYS_PER_YEAR;
}

export const stockToFlow: InputAdapter = {
  key: "stock_to_flow",
  label: "Stock-to-Flow Deviation",
  category: "market",
  source: "derived",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await computeSeries(env);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return computeSeries(env);
  },
};

async function computeSeries(env: Env): Promise<InputReading[]> {
  const prices = await fetchBtcPriceHistory(env);
  if (prices.length === 0) return [];

  const out: InputReading[] = [];
  for (const { timestamp, value: price } of prices) {
    const supply = supplyAt(timestamp);
    if (supply <= 0) continue;
    const flow = annualIssuanceAt(timestamp);
    if (flow <= 0) continue;
    const sf = supply / flow;
    const modelPrice = (Math.exp(MODEL_LN_INTERCEPT) * Math.pow(sf, MODEL_S2F_EXPONENT)) / supply;
    if (!Number.isFinite(modelPrice) || modelPrice <= 0) continue;
    out.push({ timestamp, value: (price - modelPrice) / modelPrice });
  }
  return out;
}
