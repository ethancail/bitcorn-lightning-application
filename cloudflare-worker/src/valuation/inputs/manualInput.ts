import type { Env } from "../../lib/types";
import type { InputAdapter, InputCategory, InputReading } from "./types";
import { loadManualHistory, type ManualMetricKey } from "../manualStore";

export interface ManualAdapterConfig {
  key: ManualMetricKey;
  label: string;
  category: InputCategory;
}

export function makeManualAdapter(cfg: ManualAdapterConfig): InputAdapter {
  return {
    key: cfg.key,
    label: cfg.label,
    category: cfg.category,
    source: "manual",

    async fetchLatest(env: Env): Promise<InputReading | null> {
      const history = await loadManualHistory(env.PRICES_CACHE);
      const series = history[cfg.key];
      if (!series || series.length === 0) return null;
      return series[series.length - 1];
    },

    async fetchHistory(env: Env): Promise<InputReading[]> {
      const history = await loadManualHistory(env.PRICES_CACHE);
      return history[cfg.key] ?? [];
    },
  };
}
