import { useEffect, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────

type TradingViewMiniChartProps = {
  symbol: string;
  label: string;
  dateRange?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function clearChildren(el: HTMLElement) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// ─── Component ───────────────────────────────────────────────────────────

export default function TradingViewMiniChart({
  symbol,
  label,
  dateRange = "12M",
}: TradingViewMiniChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear any previous widget
    clearChildren(container);

    // Build widget container structure
    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container";
    widgetDiv.style.width = "100%";
    widgetDiv.style.height = "100%";

    const innerDiv = document.createElement("div");
    innerDiv.className = "tradingview-widget-container__widget";
    widgetDiv.appendChild(innerDiv);

    // Inject the TradingView script with config
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js";
    script.async = true;
    script.textContent = JSON.stringify({
      symbol,
      width: "100%",
      height: "100%",
      locale: "en",
      dateRange,
      colorTheme: "dark",
      trendLineColor: "rgba(245, 158, 11, 1)",
      underLineColor: "rgba(245, 158, 11, 0.3)",
      underLineBottomColor: "rgba(245, 158, 11, 0)",
      isTransparent: true,
      autosize: true,
      largeChartUrl: "",
      chartOnly: false,
      noTimeScale: false,
    });
    widgetDiv.appendChild(script);

    container.appendChild(widgetDiv);

    return () => {
      clearChildren(container);
    };
  }, [symbol, dateRange]);

  return (
    <div className="tv-mini-chart-card">
      <div className="tv-mini-chart-label">{label}</div>
      <div ref={containerRef} className="tv-mini-chart-widget" />
    </div>
  );
}
