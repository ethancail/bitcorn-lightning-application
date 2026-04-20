import type { Env } from "../../lib/types";

export type InputCategory = "on-chain" | "market" | "mining" | "sentiment";

export interface InputReading {
  // Unix seconds at UTC midnight of the day the value belongs to
  timestamp: number;
  value: number;
}

export interface InputAdapter {
  // Must match a key in INPUT_WEIGHTS in src/valuation/composite.ts
  key: string;
  label: string;
  category: InputCategory;
  source: string; // display name of the upstream, e.g. "Glassnode"
  // Latest single reading; returns null on upstream failure (caller handles fallback)
  fetchLatest(env: Env): Promise<InputReading | null>;
  // Full history from the earliest available date up to today; ascending by timestamp
  fetchHistory(env: Env): Promise<InputReading[]>;
}
