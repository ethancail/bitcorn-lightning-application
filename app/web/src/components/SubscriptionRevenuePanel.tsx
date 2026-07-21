// Subscription Revenue — treasury dashboard widget.
//
// Data: GET /api/admin/subscription/revenue (treasury-only) + contacts
// for display names. Contacts are best-effort, same as AdminMembers:
// a failure there falls back to truncated pubkeys, never hides revenue.
//
// Headline row shows the current recurring cycle BOTH ways — the
// entitlement projection (paying members × policy price) next to what
// actually confirmed inside the window — plus all-time earnings and
// the paying/enrolled member count. "Paying" = has actually paid (≥1
// confirmed on-chain payment; see revenueHandler.ts), NOT tier
// 'current' — fresh-grace members who never paid don't count. Below it, the top earners by
// all-time revenue, named via the case-normalized contacts join in
// subscriptionRevenueView.ts. "View all" lands on /admin/members,
// which carries the full per-member breakdown.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type Contact,
  type SubscriptionRevenueResponse,
} from "../api/client";
import { fmtUsdCents, topEarners, type TopEarnerRow } from "./subscriptionRevenueView";

const POLL_INTERVAL_MS = 60_000;
const TOP_EARNERS_LIMIT = 5;

type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; revenue: SubscriptionRevenueResponse; contacts: Contact[] }
  | { kind: "error" };

export default function SubscriptionRevenuePanel() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  const fetchRevenue = useCallback(async () => {
    try {
      const [revenue, contacts] = await Promise.all([
        api.getAdminSubscriptionRevenue(),
        api.getContacts().catch(() => [] as Contact[]),
      ]);
      setView({ kind: "ok", revenue, contacts });
    } catch {
      // Keep last-good data on a failed poll; only show the error
      // state when we never loaded at all.
      setView((v) => (v.kind === "ok" ? v : { kind: "error" }));
    }
  }, []);

  useEffect(() => {
    void fetchRevenue();
    const id = setInterval(() => void fetchRevenue(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchRevenue]);

  return (
    <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">◆</span>Subscription Revenue</span>
        <Link className="sub-link" to="/admin/members">
          View all <span aria-hidden>→</span>
        </Link>
      </div>
      <div className="panel-body">
        {view.kind === "loading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2].map((i) => (
              <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />
            ))}
          </div>
        )}
        {view.kind === "error" && (
          <div className="empty-state">Unable to load subscription revenue.</div>
        )}
        {view.kind === "ok" && (
          <RevenueBody
            revenue={view.revenue}
            earners={topEarners(view.revenue.members, view.contacts, TOP_EARNERS_LIMIT)}
          />
        )}
      </div>
    </div>
  );
}

function RevenueBody({
  revenue,
  earners,
}: {
  revenue: SubscriptionRevenueResponse;
  earners: TopEarnerRow[];
}) {
  const { totals, policy } = revenue;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* ── Headline: recurring both ways + all-time + membership ── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="stat-card" style={{ flex: "1 1 150px" }}>
          <div className="stat-label">Expected / Cycle</div>
          <div className="stat-value" style={{ fontSize: "1.125rem" }}>
            {totals.recurring_entitlement_sats.toLocaleString()}
          </div>
          <div className="stat-sub">
            sats · {totals.paying_member_count} paying × {policy.price_sats.toLocaleString()}
          </div>
        </div>
        <div className="stat-card" style={{ flex: "1 1 150px" }}>
          <div className="stat-label">Received This Period</div>
          <div
            className="stat-value"
            style={{
              fontSize: "1.125rem",
              color:
                totals.recurring_actual_sats >= totals.recurring_entitlement_sats
                  ? "var(--green)"
                  : undefined,
            }}
          >
            {totals.recurring_actual_sats.toLocaleString()}
          </div>
          <div className="stat-sub">sats · last {policy.period_days} days</div>
        </div>
        <div className="stat-card" style={{ flex: "1 1 150px" }}>
          <div className="stat-label">Total Earned</div>
          <div className="stat-value" style={{ fontSize: "1.125rem" }}>
            {totals.total_earned_sats.toLocaleString()}
          </div>
          <div className="stat-sub">
            sats
            {totals.total_earned_usd_cents > 0 &&
              ` · ≈ ${fmtUsdCents(totals.total_earned_usd_cents)} at receipt`}
          </div>
        </div>
        <div className="stat-card" style={{ flex: "1 1 150px" }}>
          <div className="stat-label">Paying Members</div>
          <div className="stat-value" style={{ fontSize: "1.125rem" }}>
            {totals.paying_member_count}
          </div>
          <div className="stat-sub">
            of {totals.member_count} enrolled · ≥1 confirmed payment
          </div>
        </div>
      </div>

      {/* ── Top earners (all-time, named via contacts) ── */}
      {earners.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {earners.map((e, i) => (
            <div key={e.member_pubkey} className="policy-card" style={{ cursor: "default" }}>
              <div>
                <div className="policy-card-label">
                  <span className="text-dim" style={{ marginRight: 8 }}>#{i + 1}</span>
                  {e.name}
                </div>
                <div className="policy-card-meta">
                  {e.payment_count} payment{e.payment_count === 1 ? "" : "s"}
                  {e.total_usd_cents > 0 && ` · ≈ ${fmtUsdCents(e.total_usd_cents)} at receipt`}
                </div>
              </div>
              <div className="policy-card-value" style={{ color: "var(--green)" }}>
                {e.total_sats.toLocaleString()}
                <span className="unit">sats</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {earners.length === 0 && (
        <div className="empty-state" style={{ marginTop: 8 }}>
          No on-chain subscription payments recorded yet.
        </div>
      )}
    </div>
  );
}
