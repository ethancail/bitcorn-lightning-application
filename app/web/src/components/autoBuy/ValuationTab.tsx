import type { ValuationCurrent } from "../../api/client";

interface Props {
  valuation: ValuationCurrent | null;
}

export default function ValuationTab({ valuation }: Props) {
  if (!valuation) {
    return <div className="panel"><div className="panel-body"><em className="text-dim">Valuation data unavailable.</em></div></div>;
  }
  return <div className="panel"><div className="panel-body"><em className="text-dim">Tab 1 — coming in Task 4</em></div></div>;
}
