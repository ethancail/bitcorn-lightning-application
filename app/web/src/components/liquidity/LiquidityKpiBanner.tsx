import { HEALTH_COLOR } from "./types";
import { formatSatsShort, type LiquidityKpis } from "./transform";

type Props = { kpis: LiquidityKpis };

export default function LiquidityKpiBanner({ kpis }: Props) {
  return (
    <div className="liq-kpi-banner">
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Total Deployed</div>
        <div className="liq-kpi-value">{formatSatsShort(kpis.totalDeployed)}</div>
        <div className="liq-kpi-sub">{kpis.peerCount} peers</div>
      </div>
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Merchants Send-Ready</div>
        <div className="liq-kpi-value" style={{ color: HEALTH_COLOR[kpis.merchantsTier] }}>
          {kpis.merchantsHealthy}<span className="liq-kpi-divider">/</span>{kpis.merchantsTotal}
        </div>
        <div className="liq-kpi-sub">healthy / total</div>
      </div>
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Farmers Receive-Ready</div>
        <div className="liq-kpi-value" style={{ color: HEALTH_COLOR[kpis.farmersTier] }}>
          {kpis.farmersHealthy}<span className="liq-kpi-divider">/</span>{kpis.farmersTotal}
        </div>
        <div className="liq-kpi-sub">healthy / total</div>
      </div>
    </div>
  );
}
