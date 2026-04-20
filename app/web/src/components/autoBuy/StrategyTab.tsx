import type { AutoBuyStatus, ValuationCurrent } from "../../api/client";

interface Props {
  status: AutoBuyStatus | null;
  valuation: ValuationCurrent | null;
  onRefresh: () => void;
}

export default function StrategyTab({ status, valuation, onRefresh }: Props) {
  void onRefresh; void status; void valuation;
  return <div className="panel"><div className="panel-body"><em className="text-dim">Tab 2 — coming in Tasks 5-8</em></div></div>;
}
