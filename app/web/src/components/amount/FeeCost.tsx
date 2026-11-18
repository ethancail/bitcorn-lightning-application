// A fee-speed card's cost (Ethan's ruling "fix the five", 2026-11-16): the
// member Connect card, the treasury's open panel and its close dialog.
//
//   An estimate in the amount's form: "about $0.59" over "~770 sats"; with no
//   price, "~770 sats" alone (item 5). Each line never splits.
//
// fee-estimates (2026-11-17, MFRUI-ASKS (1)): every option, Economy included,
// now sends a live rate, so every option has a figure. "Fee set by your node"
// is retired everywhere it appeared.
//
// The close card's cost is an offer the peer may renegotiate (R2), so it reads
// "about $X, if accepted" over "~N sats" (D3). The qualifier sits on the
// figure's line but may wrap (.fee-cost-qualifier); the figure itself never
// splits. The close dialog's capture (spec §14) checks it at 1440 px.

import type { ExchangeRate } from "../../api/client";
import { Amount, usableUsd } from "./Amount";
import { formatSats, formatUsd } from "./amountDescriptor";

export function FeeCost({
  sats, rate, qualifier,
}: {
  sats: number;
  rate: ExchangeRate | null | undefined;
  /** Words after the figure, e.g. "if accepted": "about $X, if accepted". */
  qualifier?: string;
}) {
  if (!qualifier) return <Amount sats={sats} rate={rate} approx />;

  const usd = usableUsd(rate);
  const q = <span className="fee-cost-qualifier">, {qualifier}</span>;
  if (usd == null) {
    return (
      <span className="amount amount-inline" data-sats={sats}>
        <span className="amount-figure" data-line="sats">~{formatSats(sats)}{q}</span>
      </span>
    );
  }
  return (
    <span className="amount amount-inline" data-sats={sats}>
      <span className="amount-figure" data-line="usd">about {formatUsd(sats, usd).text}{q}</span>
      <span className="amount-sub" data-line="sats">~{formatSats(sats)}</span>
    </span>
  );
}
