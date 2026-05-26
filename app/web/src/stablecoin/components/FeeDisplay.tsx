// FeeDisplay — canonical fee format per spec amendment §8.
//
// "Fee: X.XX USDC (Y.Y% rate)" — explicit about both amount and rate so
// a future user reading old fee=0 settlements doesn't wonder whether the
// zero fee was an exception or the rate.
//
// Two variants:
//   variant="history"   → past-tense rate ("0.0% rate")
//   variant="preview"   → present-tense rate ("0.0% current rate"), used
//                          in the settlement form (the actual fee at
//                          execution is the rate on-chain at that moment;
//                          v1 accepts the rare-race underestimate/overestimate
//                          per spec §5)

export default function FeeDisplay({
  feeHuman,
  feeBps,
  variant,
  compact,
}: {
  feeHuman: string;
  feeBps: number;
  variant: "history" | "preview";
  compact?: boolean;
}) {
  const rateLabel = variant === "preview" ? "current rate" : "rate";
  const ratePct = (feeBps / 100).toFixed(1);
  const prefix = variant === "preview" ? "Fee Preview" : "Fee";
  if (compact) {
    return (
      <span className="stablecoin-fee-compact">
        {prefix}: {feeHuman} USDC <span className="stablecoin-fee-rate">({ratePct}% {rateLabel})</span>
      </span>
    );
  }
  return (
    <div className="stablecoin-fee">
      <span className="stablecoin-fee-label">{prefix}:</span>{" "}
      <span className="stablecoin-fee-value">{feeHuman} USDC</span>{" "}
      <span className="stablecoin-fee-rate">({ratePct}% {rateLabel})</span>
    </div>
  );
}
