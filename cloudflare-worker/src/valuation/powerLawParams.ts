// KV loader for the Daybreak power-law parameters (see powerLawZ.ts).
//
// ONE key, `daybreak_powerlaw_params_v1`, holding JSON
//   { "a": <number>, "b": <number>, "sigma": <number>, "genesis": "yyyy-mm-dd" }
// in the PRICES_CACHE namespace. The author refits roughly twice a year; KV lets
// a person change the numbers without a release or a `wrangler deploy`.
//
// Nothing in this repo writes the key. Seeding production KV is the operator's
// act, not code's — this module only reads, and its tests assert it never puts.
//
// ⚠ IT FAILS CLOSED — THE OPPOSITE OF ITS NEIGHBOURS, ON PURPOSE.
// Several existing loaders in this directory fail OPEN to an empty value:
// persist.ts loadHistory → [] and loadInputs → {} on an absent or unparseable
// key, and manualStore.ts loadManualHistory → an empty history (whose
// read-modify-write callers then overwrite the stored blob). Empty is a sane
// default for a history — nothing to show. It is NOT a sane default for model
// parameters: there is no empty σ, and any fallback value would produce a
// confident, wrong Z with nothing on the page to say so. So absent,
// unparseable, wrong-shape, non-finite, a ≤ 0 or σ ≤ 0 all return an explicit
// { ok: false } with no params attached. Do not "harmonise" this with persist.ts.
//
// A KV read that THROWS is deliberately not caught here: it propagates, which
// is also closed — no caller can mistake an exception for parameters.

import type { PowerLawParams } from "./powerLawZ";
import { checkPowerLawParams } from "./powerLawZ";

export const POWER_LAW_PARAMS_KV_KEY = "daybreak_powerlaw_params_v1";

export type PowerLawParamsUnavailable = "absent" | "unparseable" | "wrong_shape" | "invalid_value";

export type PowerLawParamsLoad =
  | { ok: true; params: PowerLawParams }
  | { ok: false; reason: PowerLawParamsUnavailable; detail: string };

export async function loadPowerLawParams(kv: KVNamespace): Promise<PowerLawParamsLoad> {
  const raw = await kv.get(POWER_LAW_PARAMS_KV_KEY);
  if (raw === null) {
    return { ok: false, reason: "absent", detail: `KV key ${POWER_LAW_PARAMS_KV_KEY} is not set` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `KV key ${POWER_LAW_PARAMS_KV_KEY} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const checked = checkPowerLawParams(parsed);
  if (!checked.ok) return { ok: false, reason: checked.kind, detail: checked.detail };
  return { ok: true, params: checked.params };
}
