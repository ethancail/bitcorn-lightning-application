import { makeManualAdapter } from "./manualInput";

// CoinMetrics free-tier note (probed 2026-04-27):
// `NVTAdj`, `NVTAdj90`, `NVTAdjFF`, and `NVTAdjFF90` are all gated behind
// paid credentials, as is the underlying `TxTfrValAdjUSD`. The SAGE doc's
// claim that CoinMetrics Community provides NVT free was overly optimistic.
// Stays on manual entry until a free upstream is found.
export const nvt = makeManualAdapter({
  key: "nvt",
  label: "NVT Signal",
  category: "market",
});
