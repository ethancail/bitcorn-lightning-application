import {
  krakenGetApiKeyInfo,
  krakenGetAssetPair,
  krakenListAddresses,
  krakenListWithdrawMethods,
  type KrakenAuth,
  type KrakenFailure,
} from "./krakenClient";

// Setting up a Kraken key (kraken-autobuy P4d): the checks the credential
// routes run before storing a key, and the setup-time STOP 2 warning. Reads
// only; nothing here moves money or writes the database.

/**
 * The key's permissions must be EXACTLY these (ruling K1 adds
 * query-closed-trades to D5's four; D-P4-11 requires all five). Anything else
 * is refused, add-withdraw-address and update-withdraw-address above all: the
 * node must never be able to change where a withdrawal goes.
 */
export const KRAKEN_REQUIRED_PERMISSIONS = [
  "query-funds",
  "query-open-trades",
  "query-closed-trades",
  "modify-trades",
  "withdraw-funds",
] as const;

export type PermissionCheck =
  | { ok: true }
  | { ok: false; error: "key_permissions_too_broad"; extra: string[] }
  | { ok: false; error: "key_permissions_missing"; missing: string[] };

/** Too broad is checked first: a key that can add withdrawal addresses is refused whatever else it lacks. */
export function checkKrakenPermissions(permissions: string[]): PermissionCheck {
  const required: readonly string[] = KRAKEN_REQUIRED_PERMISSIONS;
  const extra = permissions.filter((p) => !required.includes(p));
  if (extra.length > 0) return { ok: false, error: "key_permissions_too_broad", extra };
  const missing = required.filter((p) => !permissions.includes(p));
  if (missing.length > 0) return { ok: false, error: "key_permissions_missing", missing };
  return { ok: true };
}

/** The key's permissions read live (GetApiKeyInfo needs none), then checked. */
export async function verifyKrakenKey(
  auth: KrakenAuth,
): Promise<{ ok: true; permissions: string[] } | { ok: false; failure: KrakenFailure } | { ok: false; refused: Exclude<PermissionCheck, { ok: true }> }> {
  const info = await krakenGetApiKeyInfo(auth);
  if (!info.ok) return { ok: false, failure: info };
  const check = checkKrakenPermissions(info.info.permissions);
  if (!check.ok) return { ok: false, refused: check };
  return { ok: true, permissions: info.info.permissions };
}

/**
 * Where the node's withdraw_address sits among the account's saved Kraken
 * addresses (Funding Beta). The address picks the method: a Lightning method
 * cannot hold a bc1 address, so no method is chosen by its name.
 *   matched       exactly one withdraw method lists it, verified
 *   ambiguous     more than one does: refused, never guessed (D-P4-12)
 *   not_verified  listed, but not yet verified on Kraken
 *   not_found     not listed (the farm adds it in Kraken's UI; the node cannot)
 *   node_address_missing  the node has no withdraw_address yet
 */
export type AddressResolution =
  | { status: "matched"; methodId: string; addressId: string }
  | { status: "ambiguous"; methodIds: string[] }
  | { status: "not_verified" | "not_found" | "node_address_missing" };

const MAX_PAGES = 5;

export async function resolveKrakenWithdrawAddress(
  auth: KrakenAuth,
  withdrawAddress: string,
): Promise<{ ok: true; resolution: AddressResolution } | { ok: false; failure: KrakenFailure }> {
  if (!withdrawAddress) return { ok: true, resolution: { status: "node_address_missing" } };

  const methodIds: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await krakenListWithdrawMethods(auth, cursor);
    if (!res.ok) return { ok: false, failure: res };
    methodIds.push(...res.methods.map((m) => m.methodId));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }

  const matched: Array<{ methodId: string; addressId: string }> = [];
  let unverified = false;
  for (const methodId of methodIds) {
    let addrCursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await krakenListAddresses(auth, methodId, addrCursor);
      if (!res.ok) return { ok: false, failure: res };
      for (const a of res.addresses) {
        if (a.address !== withdrawAddress) continue;
        if (a.verified) matched.push({ methodId, addressId: a.addressId });
        else unverified = true;
      }
      if (!res.nextCursor) break;
      addrCursor = res.nextCursor;
    }
  }

  if (matched.length === 1) return { ok: true, resolution: { status: "matched", ...matched[0] } };
  if (matched.length > 1) return { ok: true, resolution: { status: "ambiguous", methodIds: matched.map((m) => m.methodId) } };
  return { ok: true, resolution: { status: unverified ? "not_verified" : "not_found" } };
}

export interface MinimumWarning {
  /** True when the smallest buy the farm's settings can produce is below Kraken's minimum at this price. */
  below: boolean;
  /** base × the smallest non-zero zone multiplier. */
  smallest_buy_usd: number;
  /** max(costmin, ordermin × price), from public AssetPairs. */
  minimum_usd: number;
  price_usd: number;
}

/**
 * The setup-time STOP 2 warning (ruling D-P4-13): is base × the smallest
 * non-zero multiplier below the pair's minimum at the current price? Computed
 * live for the response that asks; never stored, so GET /status makes no
 * Kraken call. Null when an input is unavailable (no price, no pair data, no
 * non-zero multiplier): the warning is advisory, and the buy-time skip still
 * applies.
 */
export async function minimumBuyWarning(
  baseUnitUsd: number,
  zoneMultipliersJson: string,
  priceUsd: number | null,
): Promise<MinimumWarning | null> {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  let multipliers: number[];
  try {
    multipliers = Object.values(JSON.parse(zoneMultipliersJson) as Record<string, unknown>)
      .map(Number)
      .filter((m) => Number.isFinite(m) && m > 0);
  } catch {
    return null;
  }
  if (multipliers.length === 0) return null;
  const pair = await krakenGetAssetPair();
  if (!pair.ok) return null;
  const smallest = Math.round(baseUnitUsd * Math.min(...multipliers) * 100) / 100;
  const minimum = Math.max(pair.pair.costmin ?? 0, pair.pair.ordermin * priceUsd);
  return { below: smallest < minimum, smallest_buy_usd: smallest, minimum_usd: Math.round(minimum * 100) / 100, price_usd: priceUsd };
}
