// Auto-Buy alert view helpers (Phase 2) — pure presentation logic.
//
// Per the Gate-1 "A1" decision: the UI's decision logic is extracted into pure,
// deterministic functions tested as plain `*.test.ts` (matching the repo's
// existing pure-logic test convention — no React Testing Library, no new test
// infra). The components in components/autoBuy/ call these and render; these
// functions never touch the DOM or the network.

import type { AutoBuyAlert } from "../api/client";

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

  switch (alert.type) {
    case "AUTOBUY_INSUFFICIENT_FUNDS": {
      const need = fmtUsd(ctxNum(ctx, "intended_buy_usd"));
      const checked = ctxStr(ctx, "currencies_checked") ?? "your selected currency";
      return {
        title: "Auto-Buy skipped — insufficient funds",
        message:
          `No selected currency covered the ${need} buy (checked ${checked}). ` +
          `Add funds or adjust your currency preference.`,
        icon,
      };
    }
    case "AUTOBUY_AUTH_FAILURE":
      return {
        title: "Auto-Buy paused — Coinbase credentials rejected",
        message:
          "Coinbase rejected the API key (401/403). Re-supply your key on the " +
          "Auto-Buy page to resume buying.",
        icon,
      };
    case "AUTOBUY_RATE_LIMITED": {
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
      const err = ctxStr(ctx, "error_message") ?? ctxStr(ctx, "error_code") ?? "an unexpected error";
      return {
        title: "Auto-Buy order rejected",
        message:
          `Coinbase rejected the buy order: ${err}. Repeated rejections ` +
          `(×${alert.consecutive_count}) suggest a persistent problem.`,
        icon,
      };
    }
    case "AUTOBUY_SWEEP_FAILED": {
      const btc = ctxNum(ctx, "btc_amount");
      const err = ctxStr(ctx, "error_code") ?? ctxStr(ctx, "error_message") ?? "unknown error";
      const amt = btc != null ? `${btc} BTC` : "BTC";
      return {
        title: "Sweep failed — BTC held on Coinbase",
        message:
          `${amt} was bought but not swept to your node (${err}). Your value is ` +
          `sitting on the exchange — investigate promptly.`,
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
