import type { Env } from "../lib/types";
import { fetchSpotPrice, runEngine } from "./engine";

export async function handleScheduled(env: Env): Promise<void> {
  const priceUsd = await fetchSpotPrice();
  const nowISO = new Date().toISOString();
  try {
    await runEngine(env, { priceUsd, nowISO });
  } catch (err) {
    console.error("[valuation-cron] runEngine failed:", err instanceof Error ? err.message : err);
  }
}
