import { makeManualAdapter } from "./manualInput";

// CoinMetrics free-tier note (probed 2026-04-27):
// `PuellMulRev`, `PuellMulCont`, `PuellMulTot`, `IssContUSD`, `IssContNtv`,
// and `RevAllTimeUSD` are all gated behind paid credentials. The SAGE doc's
// claim that CoinMetrics Community provides Puell inputs free was
// overly optimistic. Stays on manual entry until a free upstream is found.
export const puell = makeManualAdapter({
  key: "puell",
  label: "Puell Multiple",
  category: "on-chain",
});
