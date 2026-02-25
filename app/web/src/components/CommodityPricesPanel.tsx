import { useState, useEffect } from "react";
import { api, type CommodityPrice } from "../api/client";

// ─── Types ───────────────────────────────────────────────────────────────

type PriceItem = {
  key: string;
  label: string;
  price: number | null;
  unit: string;
  color: string;
  glow: string;
  icon: JSX.Element;
  loading: boolean;
};

// ─── Icons ───────────────────────────────────────────────────────────────

const BtcIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 8h4.5a2 2 0 0 1 0 4H9V8z" />
    <path d="M9 12h5a2 2 0 0 1 0 4H9v-4z" />
    <path d="M10 6v2m4-2v2m-4 8v2m4-2v2" />
  </svg>
);

const GoldIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.5 8.5h4a1.5 1.5 0 0 1 0 3H10a1.5 1.5 0 0 0 0 3h4.5" />
    <path d="M12 6.5v1.5m0 8.5v-1.5" />
  </svg>
);

const CornIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22V10" />
    <path d="M7 11c0-3.5 2.2-6.5 5-8 2.8 1.5 5 4.5 5 8" />
    <path d="M7 11c1.5 0 3.2.5 5 2 1.8-1.5 3.5-2 5-2" />
    <path d="M8 14.5c1.3 0 2.7.5 4 1.5 1.3-1 2.7-1.5 4-1.5" />
    <path d="M9 18c1 0 2 .3 3 1 1-.7 2-1 3-1" />
  </svg>
);

const SoybeansIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="9" cy="12" rx="4" ry="6" />
    <ellipse cx="15" cy="12" rx="4" ry="6" />
    <path d="M12 6v12" />
  </svg>
);

const WheatIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22V7" />
    <path d="M8 9c2-2 4-2 4-2s2 0 4 2" />
    <path d="M7 12c2-2 5-2 5-2s3 0 5 2" />
    <path d="M8 15c2-1.5 4-1.5 4-1.5s2 0 4 1.5" />
    <path d="M12 3c0 0-1 2-1 4" />
    <path d="M12 3c0 0 1 2 1 4" />
  </svg>
);

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatPrice(price: number): string {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ─── Component ───────────────────────────────────────────────────────────

type Props = {
  btcPrice?: number;
  btcLoading?: boolean;
};

export default function PriceTickerStrip({ btcPrice, btcLoading }: Props) {
  const [commodities, setCommodities] = useState<Record<string, CommodityPrice> | null>(null);

  useEffect(() => {
    api.getCommodityPrices().then(setCommodities).catch(() => {});
    const id = setInterval(() => {
      api.getCommodityPrices().then(setCommodities).catch(() => {});
    }, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const items: PriceItem[] = [
    {
      key: "btc",
      label: "BTC",
      price: btcPrice ?? null,
      unit: "USD",
      color: "#f59e0b",
      glow: "rgba(245,158,11,0.12)",
      icon: BtcIcon,
      loading: btcLoading ?? false,
    },
    {
      key: "gold",
      label: "Gold",
      price: commodities?.gold?.price ?? null,
      unit: commodities?.gold?.unit ?? "$/oz",
      color: "#eab308",
      glow: "rgba(234,179,8,0.12)",
      icon: GoldIcon,
      loading: !commodities,
    },
    {
      key: "corn",
      label: "Corn",
      price: commodities?.corn?.price ?? null,
      unit: commodities?.corn?.unit ?? "$/bu",
      color: "#22c55e",
      glow: "rgba(34,197,94,0.10)",
      icon: CornIcon,
      loading: !commodities,
    },
    {
      key: "soybeans",
      label: "Soy",
      price: commodities?.soybeans?.price ?? null,
      unit: commodities?.soybeans?.unit ?? "$/bu",
      color: "#a78bfa",
      glow: "rgba(167,139,250,0.10)",
      icon: SoybeansIcon,
      loading: !commodities,
    },
    {
      key: "wheat",
      label: "Wheat",
      price: commodities?.wheat?.price ?? null,
      unit: commodities?.wheat?.unit ?? "$/bu",
      color: "#d97706",
      glow: "rgba(217,119,6,0.12)",
      icon: WheatIcon,
      loading: !commodities,
    },
  ];

  return (
    <div className="price-ticker-strip">
      {items.map((item) => (
        <div key={item.key} className="price-ticker" style={{ borderColor: item.price ? item.color + "25" : undefined }}>
          <div className="price-ticker-icon" style={{ background: item.glow }}>
            {item.icon}
          </div>
          <div className="price-ticker-info">
            <div className="price-ticker-label" style={{ color: item.color }}>
              {item.label}
            </div>
            {item.loading ? (
              <div className="loading-shimmer" style={{ height: 16, width: 60, borderRadius: 3 }} />
            ) : item.price != null ? (
              <div className="price-ticker-value">
                <span className="price-ticker-dollar">$</span>
                {formatPrice(item.price)}
              </div>
            ) : (
              <div className="price-ticker-value" style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>—</div>
            )}
            <div className="price-ticker-unit">{item.unit}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
