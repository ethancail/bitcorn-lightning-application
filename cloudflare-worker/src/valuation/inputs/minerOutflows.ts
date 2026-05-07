import { makeManualAdapter } from "./manualInput";

// Switched from CryptoQuant API fetch to manual entry in v1.13.19. The
// operator-facing metric is the Glassnode "Miner Outflow Multiple" — the
// ratio of current miners' outflow to its 365-day MA in USD. Stationary
// across cycles (z-scores cleanly), shape parallels Puell Multiple. Source
// chart: https://studio.glassnode.com/charts/mining.MinersOutflowMultiple
//
// The DB key (miner_outflows) and composite weight (0.04) are unchanged
// from the CryptoQuant era — only the source/label changed.
export const minerOutflows = makeManualAdapter({
  key: "miner_outflows",
  label: "Miner Outflow Multiple",
  category: "mining",
});
