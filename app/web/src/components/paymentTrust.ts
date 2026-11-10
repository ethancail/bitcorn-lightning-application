// Payment-trust states S1–S6 — when this node won't pay, and why.
//
// Source of truth: bitcorn-research specs/2026-11-10-treasury-price-trust-
// spec.md §8. ⚠ ALL COPY HERE IS DRAFT: the drive-mode chat reviews it for
// contradictory claims before the screenshot gate (G3), and Ethan approves it
// there (ruling 5). Nothing here verifies anything: verification runs in this
// node's API only (member nodes serve this web over plain HTTP), and the web
// learns the verdict from the status proxy's `treasury_signature` label.
//
// Pure, so every surface reads one mapping: the Settings panel's notice, the
// pay modal's quote and send refusals, the auto-pay section, and the auto-pay
// alert copy.

import type {
  AutoPayConfig,
  SubscriptionStatus,
  TreasuryPayRefusal,
  TreasurySignature,
} from "../api/client";

export type TrustState =
  | { state: "S1_unsigned" }
  | { state: "S2_invalid" }
  | { state: "S3_unverifiable"; reason: "key_unset" | "lnd_unavailable" }
  | { state: "S4_price_above_cap"; price_sats: number }
  | { state: "S5_price_not_integer" }
  | { state: "S6_deposit_address_changed"; pinned: string | null; stated: string };

/** An address shortened for copy: head…tail. */
export function shortAddress(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length <= 16 ? a : `${a.slice(0, 8)}…${a.slice(-6)}`;
}

function fromVerdict(
  verdict: TreasurySignature | string | null | undefined,
  reason: string | null | undefined,
): TrustState | null {
  switch (verdict) {
    case "verified":
      return null;
    case "invalid":
      return { state: "S2_invalid" };
    case "unverifiable":
      return { state: "S3_unverifiable", reason: reason === "key_unset" ? "key_unset" : "lnd_unavailable" };
    default:
      // "unsigned", and a missing label: not verified.
      return { state: "S1_unsigned" };
  }
}

function fromPayRefusal(r: TreasuryPayRefusal | Record<string, unknown> | null | undefined): TrustState | null {
  if (!r || typeof r !== "object") return null;
  const code = (r as { code?: unknown }).code;
  if (code === "price_above_cap") {
    const p = (r as { price_sats?: unknown }).price_sats;
    return { state: "S4_price_above_cap", price_sats: typeof p === "number" ? p : NaN };
  }
  if (code === "price_not_integer") return { state: "S5_price_not_integer" };
  if (code === "deposit_address_changed") {
    const pinned = (r as { pinned_address?: unknown }).pinned_address;
    const stated = (r as { stated_address?: unknown }).stated_address;
    return {
      state: "S6_deposit_address_changed",
      pinned: typeof pinned === "string" ? pinned : null,
      stated: typeof stated === "string" ? stated : "",
    };
  }
  return null;
}

/** The state a status puts payments in, or null when this node may pay. */
export function trustStateOfStatus(status: SubscriptionStatus | null | undefined): TrustState | null {
  if (!status) return null;
  return (
    fromVerdict(status.treasury_signature, status.treasury_signature_reason) ??
    fromPayRefusal(status.treasury_pay_refusal)
  );
}

/** The state GET /api/profile/auto-pay reports (S1–S5), or null: verified and
 *  payable, or the treasury could not be read (no claim either way). */
export function trustStateOfAutoPayConfig(cfg: AutoPayConfig | null | undefined): TrustState | null {
  if (!cfg || cfg.status_verification == null) return null;
  return fromVerdict(cfg.status_verification, cfg.status_verification_reason) ?? fromPayRefusal(cfg.price_refusal);
}

/** Whether the auto-pay opt-in may be turned ON: only on a verified status
 *  with a price this node would pay (spec §4 R3, R10). Turning it OFF is
 *  always allowed. */
export function autoPayCanEnable(cfg: AutoPayConfig | null | undefined): boolean {
  return !!cfg && cfg.status_verification === "verified" && !cfg.price_refusal;
}

/** The state an API refusal names (quote or send), or null for any other
 *  error. `body` is the refusal's JSON body (apiFetch's err.body). */
export function trustStateOfRefusal(code: string | undefined, body: unknown): TrustState | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (code === "status_unverified") {
    return fromVerdict(b.reason as string, b.verification_reason as string) ?? { state: "S1_unsigned" };
  }
  return fromPayRefusal({ ...b, code });
}

/**
 * The draft copy (spec §8), as one text and as a headline (its first
 * sentence) plus body (the rest), for the alert surfaces. `priceText` is the
 * S4 price already formatted by the caller: dollars first where the surface
 * has a rate, sats otherwise.
 */
export function trustCopy(
  s: TrustState,
  priceText?: string,
): { text: string; headline: string; body: string } {
  const split = (headline: string, body = "") => ({
    text: body ? `${headline} ${body}` : headline,
    headline,
    body,
  });
  switch (s.state) {
    case "S1_unsigned":
      return split(
        "Payments are paused.",
        "Your node can't yet confirm this information came from Bitcorn. Nothing has been sent.",
      );
    case "S2_invalid":
      return split(
        "Payments are blocked.",
        "The subscription details your node received failed a security check. Nothing has been sent.",
      );
    case "S3_unverifiable":
      return s.reason === "key_unset"
        ? split("This node is missing Bitcorn's treasury key.", "Update the app to make payments.")
        : split("Your node's Lightning service isn't responding, so payments are paused.");
    case "S4_price_above_cap":
      return split(
        "Payments are paused.",
        `The subscription price, ${priceText ?? "—"}, is above the limit built into this app.`,
      );
    case "S5_price_not_integer":
      return split("Payments are paused.", "The subscription price arrived in a form this app won't pay.");
    case "S6_deposit_address_changed":
      // ⚠ OWED (spec §8): the host command, or a support pointer, and its wording.
      return split(
        `Your subscription payment address has changed, from ${shortAddress(s.pinned)} to ${shortAddress(s.stated)}.`,
        "Your node won't send to a new address until you confirm it on the node itself. Nothing has been sent.",
      );
  }
}
