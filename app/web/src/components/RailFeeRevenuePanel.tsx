// Treasury dashboard panel: rail fee revenue, in USDC.
//
// ⚠ THIS DOES NOT CONTRADICT THE DECISION TO KEEP RAIL SURFACES OFF THE
// TREASURY SHELL (App.tsx, the Settings "Stablecoin Wallet" pointer note).
// That decision is about the treasury not being a rail PARTICIPANT: no
// /stablecoin route, no nav entry, no RailScope, no wallet registration, and
// none of that changes here. This panel is the treasury OPERATOR's view of
// revenue its own router charged — the same business as the Subscription
// Revenue panel directly above it. It renders a number from the treasury's own
// SQLite; it connects no wallet, imports no wagmi, and offers no rail action.
// If a future edit adds an action to this panel, that is the moment the
// decision would actually be eroding.
//
// USDC ONLY, and deliberately not folded into the sats hero above. Fee revenue
// is dollar-denominated; converting it through a live BTC price would invent a
// number that was never true at any moment. The two figures sit side by side
// and stay in their own units.
//
// The view states live in ./railFeeRevenueView.ts (pure, unit-tested) because
// app/web/vitest.config.ts collects only `src/**/*.test.ts` — logic left in
// here could not be tested at all.

import { useCallback, useEffect, useState } from "react";
import { api, type RailFeeRevenueResponse } from "../api/client";
import ErrorState from "./ErrorState";
import { deriveRailFeeView, type RailFeeView } from "./railFeeRevenueView";

const POLL_INTERVAL_MS = 60_000;

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export default function RailFeeRevenuePanel() {
  const [view, setView] = useState<RailFeeView>({ kind: "loading" });
  const [prior, setPrior] = useState<RailFeeRevenueResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getAdminRailFeeRevenue();
      setPrior(data);
      setView(deriveRailFeeView(data, null));
    } catch {
      // Keep last-good data rather than collapsing to an empty value that would
      // read as "no revenue" (the U24 rule — see ErrorState.tsx).
      setPrior((p) => {
        setView(deriveRailFeeView(null, p));
        return p;
      });
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">◇</span>Stablecoin Fee Revenue
        </span>
        <span className="panel-subtitle" style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
          USDC
        </span>
      </div>
      <div className="panel-body">
        {view.kind === "loading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2].map((i) => (
              <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />
            ))}
          </div>
        )}

        {/* STATUS, NOT FAILURE. Deliberately not ErrorState: nothing is broken,
            the sync loop simply has not run here yet. This is what the treasury
            shows on day one, so it must not look like an outage. */}
        {view.kind === "never_synced" && (
          <div className="empty-state">
            <div style={{ marginBottom: 4 }}>Rail indexing hasn&rsquo;t run on this node yet.</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
              Fee revenue appears once the BASE sync loop completes its first pass.
              No figure is shown until then — a zero here would claim something
              this node hasn&rsquo;t checked.
            </div>
          </div>
        )}

        {view.kind === "error" && (
          <ErrorState
            bare
            message="Unable to load rail fee revenue."
            onRetry={() => void load()}
          />
        )}

        {(view.kind === "ok" || view.kind === "stale") && (
          <Figures data={view.data} doubted={view.kind === "stale"} />
        )}
      </div>
    </div>
  );
}

function Figures({ data, doubted }: { data: RailFeeRevenueResponse; doubted: boolean }) {
  const { all_time, last_24h, freshness } = data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="revenue-hero">
        <span
          className="revenue-hero-num"
          style={{ color: doubted ? "var(--text-3)" : "var(--green)" }}
          aria-label={`All-time rail fee revenue: ${all_time.fee_human} USDC`}
        >
          ${all_time.fee_human}
        </span>
        <span className="revenue-hero-caption">USDC · all-time fees charged</span>
      </div>

      <div className="policy-card" style={{ cursor: "default" }}>
        <div>
          <div className="policy-card-label">Last ~24h</div>
          {/* "~24h" and the block range, not a bare "24h": the window is
              43,200 blocks below the cursor at Base's fixed 2s slot. Stating
              the range means a reader never has to trust the approximation. */}
          <div className="policy-card-meta">
            blocks {last_24h.from_block.toLocaleString()}–{last_24h.to_block.toLocaleString()} ·{" "}
            {last_24h.settlement_count} settlement{last_24h.settlement_count === 1 ? "" : "s"}
          </div>
        </div>
        <div className="policy-card-value" style={{ color: doubted ? "var(--text-3)" : "var(--green)" }}>
          ${last_24h.fee_human}
          <span className="unit">USDC</span>
        </div>
      </div>

      <div className="policy-card" style={{ cursor: "default" }}>
        <div>
          <div className="policy-card-label">Settlements</div>
          <div className="policy-card-meta">
            all-time · ${all_time.gross_human} USDC gross routed
          </div>
        </div>
        <div className="policy-card-value">{all_time.settlement_count}</div>
      </div>

      {doubted ? (
        <div
          role="status"
          style={{ fontSize: "0.75rem", color: "var(--amber)", marginTop: 4 }}
        >
          ⚠ Last indexed {ageLabel(freshness.staleness_seconds)} — newer settlements may
          not be counted yet.
        </div>
      ) : (
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
          {all_time.settlement_count === 0
            ? "No settlements yet. "
            : ""}
          Current as of block {freshness.last_synced_block_number.toLocaleString()},{" "}
          {ageLabel(freshness.staleness_seconds)}.
        </div>
      )}

      {/* Says what the number is and what it is not. Fees were DELIVERED (the
          Settled event is emitted after the fee transfer, which reverts the
          whole call on failure) — but this is cumulative delivery, not a
          balance: sweeps out of the recipient are not tracked, and a fee is
          attributed to the ROUTER that charged it, not to whichever address was
          the recipient at that block. */}
      <div style={{ fontSize: "0.7rem", color: "var(--text-3)", marginTop: 2 }}>
        Total charged by the router and delivered to the fee recipient. Not a
        balance — sweeps aren&rsquo;t tracked.
        {data.fee_recipient_address && (
          <> Current recipient: <code>{data.fee_recipient_address.slice(0, 10)}…</code></>
        )}
      </div>
    </div>
  );
}
