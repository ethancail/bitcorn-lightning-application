// Withdraw's and Top Up's option cards (drive-mode P3, plan item 4; the record
// :54; R11(6)). Drive-mode's own page content, not a shared visual-system
// component (spec §1.3): the cards, the recommended one and why, all from
// GET /api/swaps/options.
//
// A card NEVER starts anything. "Use the most" / "Use this amount" only
// pre-fill the page's existing amount, and the member still gets a quote and
// confirms it; "Leave it for now" goes back to the dashboard; "Deposit
// Bitcoin" opens Deposit. A card whose cost is over the member's fee limit says
// so, and its button stays off until the member ticks that they'd allow it
// this once (a UI-only acknowledgement; no request body changes). The fee
// limit is a dollar figure (R48), so with no price the server can't check a
// card and flags none (R59(2)): each card with a fee says so in one neutral
// sentence instead, and its fee shows in sats.
//
// Exactly one card is recommended (D3.3) — the server marks it; this renders
// one badge and one reason line for it. Amounts are the interim: dollars with
// sats beneath.

import { useState } from "react";
import type { OptionCardKey, OptionReason, SwapOptions } from "../api/client";

const TITLE: Record<OptionCardKey, { farmer: string; merchant: string }> = {
  now: { farmer: "Move it all now", merchant: "Top up now" },
  wait_bigger: { farmer: "Wait for a bigger transfer", merchant: "Wait for a bigger transfer" },
  wait_calm: { farmer: "Wait for calm fees", merchant: "Wait for calm fees" },
  wait_lower: { farmer: "Wait until room to send is lower", merchant: "Wait until room to send is lower" },
  deposit_first: { farmer: "Deposit bitcoin first", merchant: "Deposit bitcoin first" },
  wait: { farmer: "Wait", merchant: "Wait" },
};

export function reasonText(reason: OptionReason, farmer: boolean): string {
  switch (reason) {
    case "room_low": return farmer ? "Room to receive is low, so waiting costs you payments." : "Room to send is already low.";
    case "fees_low": return "Fees are low today.";
    case "fees_high": return farmer
      ? "Fees are high today, and a later, bigger transfer costs a smaller share."
      : "Fees are high today, and you still have enough ready to send.";
    case "over_fee_limit": return farmer
      ? "Today's fee is over your fee limit, and a later, bigger transfer costs a smaller share."
      : "Today's fee is over your fee limit, and you still have enough ready to send.";
    case "bigger_share": return "A later, bigger transfer costs a smaller share.";
    // R59(4): the strategy's name as the Automatic transfers page shows it;
    // the name alone, no "which…" clause ("recs" 2026-11-12 (1)).
    case "keep_room_open": return farmer ? "You're on Move sooner." : "You're on Top up sooner.";
    case "plenty_ready": return "You still have plenty ready to send, so you don't need to top up yet.";
    case "enough_ready": return "You still have enough ready to send.";
    case "wallet_low": return "Your wallet is too low to top up.";
  }
}

export const OVER_LIMIT_SENTENCE = "That's over your fee limit, so you'd allow it once.";

/** R59(2), verbatim. */
export const NO_PRICE_LIMIT_SENTENCE = "Can't check this against your fee limit right now: the bitcoin price isn't available.";

function Amount({ sats, usd }: { sats: number; usd: number | null }) {
  const dollars = usd != null ? `$${((sats / 100_000_000) * usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  if (!dollars) return <span data-testid="amount" data-sats={sats} style={{ fontWeight: 600 }}>{sats.toLocaleString()} sats</span>;
  return (
    <span data-testid="amount" data-sats={sats} style={{ display: "inline-flex", flexDirection: "column", verticalAlign: "top", lineHeight: 1.2 }}>
      <span style={{ fontWeight: 600 }}>{dollars}</span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>{sats.toLocaleString()} sats</span>
    </span>
  );
}

export function OptionCards({
  options, usd, onUse, onLeave, onDeposit,
}: {
  options: SwapOptions;
  usd: number | null;
  onUse: (amountSats: number) => void;
  onLeave: () => void;
  onDeposit: () => void;
}) {
  const farmer = options.direction === "loop_out";
  const [allowOnce, setAllowOnce] = useState(false);
  if (options.state !== "ok" || options.cards.length === 0) return null;
  const room = options.room_sats;
  const floor = options.floor_sats;

  const consequence = (key: OptionCardKey, amount: number | null): JSX.Element | null => {
    if (room == null) return null;
    switch (key) {
      case "now":
        return amount == null ? null : farmer
          ? <>Room to receive rises to <Amount sats={room + amount} usd={usd} />.</>
          : <>Room to send rises to <Amount sats={room + amount} usd={usd} />.</>;
      case "wait_bigger":
        return floor == null ? null : <>Worth more once room to receive has dropped to <Amount sats={floor} usd={usd} />.</>;
      case "wait_calm":
        return farmer
          ? <>Room to receive stays at <Amount sats={room} usd={usd} /> until then, so a payment larger than that is refused.</>
          : <>Room to send stays at <Amount sats={room} usd={usd} /> until then.</>;
      case "wait_lower":
        return <>Room to send is <Amount sats={room} usd={usd} /> now.</>;
      case "deposit_first":
        return <>A top-up needs more in your wallet than it has.</>;
      case "wait":
        return <>Room to send stays at <Amount sats={room} usd={usd} />. Nothing can be added until you deposit.</>;
    }
  };

  return (
    <div data-testid="option-cards" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {options.cards.map((c) => {
        const over = c.over_fee_limit;
        const usable = c.key === "now" && c.amount_sats != null;
        return (
          <div
            key={c.key}
            data-testid={`option-card-${c.key}`}
            data-recommended={c.recommended ? "true" : "false"}
            style={{
              flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px",
              borderRadius: 8, background: "var(--bg-2)",
              border: `1px solid ${c.recommended ? "var(--amber)" : "var(--border)"}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{TITLE[c.key][farmer ? "farmer" : "merchant"]}</span>
              {c.recommended && <span className="badge badge-green" data-testid="recommended-badge">Recommended</span>}
            </div>
            {c.amount_sats != null && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.8125rem" }}>
                <span><span className="text-dim">Amount </span><Amount sats={c.amount_sats} usd={usd} /></span>
                {c.fee_sats != null && <span><span className="text-dim">Fee, at today's fees </span><Amount sats={c.fee_sats} usd={usd} /></span>}
              </div>
            )}
            <div style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>
              {consequence(c.key, c.amount_sats)}
              {over && <> <span data-testid="over-limit">{OVER_LIMIT_SENTENCE}</span></>}
            </div>
            {options.fee_limit_checked === false && c.fee_sats != null && (
              <div data-testid="limit-unchecked" style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>{NO_PRICE_LIMIT_SENTENCE}</div>
            )}
            {c.recommended && options.reason && (
              <div data-testid="recommended-reason" style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>{reasonText(options.reason, farmer)}</div>
            )}
            {usable && over && (
              <label style={{ fontSize: "0.75rem", display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={allowOnce} onChange={(e) => setAllowOnce(e.target.checked)} />
                Allow it this once
              </label>
            )}
            <div style={{ marginTop: "auto" }}>
              {usable ? (
                <button
                  className={`btn ${c.recommended ? "btn-primary" : "btn-outline"}`}
                  disabled={over && !allowOnce}
                  onClick={() => onUse(c.amount_sats!)}
                >
                  {farmer ? "Use the most" : "Use this amount"}
                </button>
              ) : c.key === "deposit_first" ? (
                <button className={`btn ${c.recommended ? "btn-primary" : "btn-outline"}`} onClick={onDeposit}>Deposit Bitcoin</button>
              ) : (
                <button className="btn btn-outline" onClick={onLeave}>Leave it for now</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
