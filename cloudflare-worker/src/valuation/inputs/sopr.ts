import { makeManualAdapter } from "./manualInput";

// CoinMetrics free-tier note (probed 2026-04-27):
// `SOPR`, `SOPROut`, and all `SOPRSth*` / `SOPRLth*` cohort variants are
// gated behind paid credentials. The SAGE doc's claim that CoinMetrics
// Community provides SOPR free was overly optimistic. Stays on manual entry
// until a free upstream is found.
export const sopr = makeManualAdapter({
  key: "sopr",
  label: "SOPR (30d MA)",
  category: "on-chain",
});
