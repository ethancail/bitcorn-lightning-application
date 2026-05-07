import { makeManualAdapter } from "./manualInput";

// Switched from CryptoQuant API fetch to manual entry in v1.13.16. Operators
// now enter Miner Outflows weekly via /valuation-input alongside the other
// 8 manual Glassnode metrics. Keeps all manual inputs on a single subscription
// (Glassnode) and removes the CryptoQuant API key dependency.
export const minerOutflows = makeManualAdapter({
  key: "miner_outflows",
  label: "Miner Outflows",
  category: "mining",
});
