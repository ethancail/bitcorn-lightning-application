// Auto-Buy alert view helpers (Phase 2) — pure presentation logic.
//
// Per the Gate-1 "A1" decision: the UI's decision logic is extracted into pure,
// deterministic functions tested as plain `*.test.ts` (matching the repo's
// existing pure-logic test convention — no React Testing Library, no new test
// infra). The components in components/autoBuy/ call these and render; these
// functions never touch the DOM or the network.

import type { AutoBuyAlert } from "../api/client";
import { exchangeName } from "./exchangeCopy";

export type BadgeSeverity = "warning" | "critical" | null;

export interface AlertSummary {
  /** Short heading rendered in .alert-type. */
  title: string;
  /** Body sentence rendered in .alert-msg. */
  message: string;
  /** Severity glyph matching Dashboard.tsx (✕ critical / ⚠ warning). */
  icon: "✕" | "⚠";
}

export interface HistoryFilters {
  status?: "active" | "resolved" | "dismissed" | "all";
  severity?: "warning" | "critical" | "all";
  type?: string | "all";
}

// ── helpers ─────────────────────────────────────────────────────────────

function ctxNum(ctx: Record<string, unknown> | null, key: string): number | null {
  const v = ctx?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function ctxStr(ctx: Record<string, unknown> | null, key: string): string | null {
  const v = ctx?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Compact USD — "$25" / "$1,250.50", null-safe. */
function fmtUsd(n: number | null): string {
  if (n == null) return "the intended amount";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// ── deriveBadge ───────────────────────────────────────────────────────────

/**
 * Reduce a set of active alerts to the nav-badge state (spec §4a): the count
 * and the highest severity present (critical > warning). Returns severity null
 * when the set is empty. Input is expected to be the active-alert list, but
 * defensively ignores any non-active rows.
 */
export function deriveBadge(alerts: AutoBuyAlert[]): { count: number; severity: BadgeSeverity } {
  const activeOnly = alerts.filter((a) => a.status === "active");
  if (activeOnly.length === 0) return { count: 0, severity: null };
  const severity: BadgeSeverity = activeOnly.some((a) => a.severity === "critical")
    ? "critical"
    : "warning";
  return { count: activeOnly.length, severity };
}

// ── orderActiveAlerts ───────────────────────────────────────────────────────

/**
 * Banner ordering (spec §4b / OQ5): critical before warning, then most-recent
 * `updated_at` first. Pure and stable — does not mutate the input.
 */
export function orderActiveAlerts(alerts: AutoBuyAlert[]): AutoBuyAlert[] {
  const rank = (s: string) => (s === "critical" ? 0 : 1);
  return [...alerts].sort((a, b) => {
    const bySeverity = rank(a.severity) - rank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (b.updated_at ?? 0) - (a.updated_at ?? 0);
  });
}

// ── summarizeAlert ──────────────────────────────────────────────────────────

/**
 * Map a stored alert to its human-readable banner/history copy (spec §4b,
 * OQ1). The machine `type` strings are fixed; this is where they become words.
 * Tolerant of NULL / partial context (Phase 1 §9 null-guard convention).
 */
export function summarizeAlert(alert: AutoBuyAlert): AlertSummary {
  const icon: "✕" | "⚠" = alert.severity === "critical" ? "✕" : "⚠";
  const ctx = alert.context ?? null;

  // The exchange the alert was raised on (P6, D-P6-1): the API records
  // provider "kraken" on a Kraken alert; an alert without one is Coinbase's.
  const ex = exchangeName(ctxStr(ctx, "provider"));
  const kraken = ex === "Kraken";
  const btc = ctxNum(ctx, "btc_amount");
  const amtBtc = btc != null ? `${btc} BTC` : "the BTC";

  switch (alert.type) {
    case "AUTOBUY_INSUFFICIENT_FUNDS": {
      const need = fmtUsd(ctxNum(ctx, "intended_buy_usd"));
      const checked = ctxStr(ctx, "currencies_checked") ?? "your selected currency";
      return {
        title: "Auto-Buy skipped — insufficient funds",
        message:
          `No selected currency covered the ${need} buy (checked ${checked}). ` +
          `Add funds or adjust your currency preference.` +
          (kraken ? " USDC isn't used for Kraken buys." : ""),
        icon,
      };
    }
    case "AUTOBUY_AUTH_FAILURE":
      if (kraken) {
        return {
          title: "Auto-Buy paused: Kraken key refused",
          message: "Kraken refused the API key. Check that the key still exists with the five permissions, then connect it again.",
          icon,
        };
      }
      return {
        title: "Auto-Buy paused — Coinbase credentials rejected",
        message:
          "Coinbase rejected the API key (401/403). Re-supply your key on the " +
          "Auto-Buy page to resume buying.",
        icon,
      };
    case "AUTOBUY_RATE_LIMITED": {
      if (kraken) {
        const err = ctxStr(ctx, "error") ?? "an error";
        return {
          title: "Kraken busy or rate-limited",
          message: `Kraken returned "${err}". This is usually brief; Auto-Buy tries again on its next run.`,
          icon,
        };
      }
      const status = ctxNum(ctx, "http_status");
      return {
        title: "Coinbase rate-limited or unavailable",
        message:
          `A Coinbase call returned ${status ?? "429/5xx"}. Usually transient — ` +
          `the scheduler retries on the next tick.`,
        icon,
      };
    }
    case "AUTOBUY_ORDER_FAILED": {
      if (ctxStr(ctx, "error_code") === "outcome_unknown") {
        const usd = ctxNum(ctx, "intended_buy_usd");
        return {
          title: "Buy outcome unknown",
          message:
            `${ex} didn't confirm whether the ${usd != null ? `${fmtUsd(usd)} ` : ""}buy went through. ` +
            `Auto-Buy won't buy twice: it checks on its next run. Three unknowns in a row pause Auto-Buy.`,
          icon,
        };
      }
      const err = ctxStr(ctx, "error_message") ?? ctxStr(ctx, "error_code") ?? "an unexpected error";
      return {
        title: "Auto-Buy order rejected",
        message:
          `${ex} rejected the buy order: ${err}. Repeated rejections ` +
          `(×${alert.consecutive_count}) suggest a persistent problem.`,
        icon,
      };
    }
    case "AUTOBUY_SWEEP_FAILED": {
      const err = ctxStr(ctx, "error_code") ?? ctxStr(ctx, "error_message") ?? "unknown error";
      if (kraken && ctxStr(ctx, "error_code") === "withdraw_outcome_unknown") {
        // D-P6-3: the BTC may already be on its way, so never "withdraw it yourself" first.
        return {
          title: "Withdrawal outcome unknown",
          message:
            `Kraken didn't confirm whether ${amtBtc} was sent to your node, and Auto-Buy won't send it again. ` +
            `Check Withdrawals in Kraken. If it's listed, it's on its way. ` +
            `If not, the BTC is still on Kraken; withdraw it yourself to your node's saved address.`,
          icon,
        };
      }
      if (kraken) {
        // G6: the BTC did not leave Kraken; say so, and how to move it by hand.
        return {
          title: "Withdrawal failed: your BTC is safe on Kraken",
          message:
            `${btc != null ? amtBtc : "The BTC"} was bought but Kraken didn't send it to your node (${err}). ` +
            `For example, Kraken may be holding the funds for review. ` +
            `To move it yourself, in Kraken go to Withdraw → Bitcoin, pick your node's saved address, and withdraw ${amtBtc}. ` +
            `Auto-Buy won't retry this withdrawal.`,
          icon,
        };
      }
      const amt = btc != null ? `${btc} BTC` : "BTC";
      return {
        title: "Sweep failed — BTC held on Coinbase",
        message:
          `${amt} was bought but not swept to your node (${err}). Your value is ` +
          `sitting on the exchange — investigate promptly.`,
        icon,
      };
    }
    case "AUTOBUY_BUY_BELOW_MINIMUM": {
      const usd = ctxNum(ctx, "intended_buy_usd");
      const min = ctxNum(ctx, "minimum_usd");
      return {
        title: `Buy skipped: below ${ex}'s minimum`,
        message:
          `Auto-Buy skipped a ${fmtUsd(usd)} buy because ${min != null ? `${ex}'s minimum is about ${fmtUsd(min)}` : `it is below ${ex}'s minimum`}. ` +
          `Buys are never rounded up. To buy in this zone, raise your base buy or this zone's multiplier.`,
        icon,
      };
    }
    case "AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL":
      return {
        title: "Withdrawal waiting for approval",
        message:
          `${ex} is holding a withdrawal of ${amtBtc} to your node until someone on your ${ex} account approves it. ` +
          `Approve it in ${ex} and Auto-Buy will pick up the result. If it's rejected, the BTC stays on ${ex}.`,
        icon,
      };
    case "AUTOBUY_LOW_FUNDS": {
      const usd = ctxNum(ctx, "usd_available");
      const next = ctxNum(ctx, "next_buy_usd");
      const n = ctxNum(ctx, "buys_covered");
      return {
        title: `Low funds on ${ex}`,
        message:
          `${fmtUsd(usd)} USD covers ${n ?? "fewer than 2"} of your next buys (${fmtUsd(next)} each at the current zone). ` +
          `Add USD to ${ex}, or raise your recurring deposit, to keep Auto-Buy buying. USDC isn't used for ${ex} buys.`,
        icon,
      };
    }
    default:
      return {
        title: alert.type,
        message: "An Auto-Buy alert was raised.",
        icon,
      };
  }
}

// ── filterHistory ───────────────────────────────────────────────────────────

/**
 * Client-side history filtering (spec §4c). Each filter defaults to "all"
 * (undefined ⇒ no constraint). Pure; does not mutate the input.
 */
export function filterHistory(alerts: AutoBuyAlert[], filters: HistoryFilters): AutoBuyAlert[] {
  const { status, severity, type } = filters;
  return alerts.filter((a) => {
    if (status && status !== "all" && a.status !== status) return false;
    if (severity && severity !== "all" && a.severity !== severity) return false;
    if (type && type !== "all" && a.type !== type) return false;
    return true;
  });
}
