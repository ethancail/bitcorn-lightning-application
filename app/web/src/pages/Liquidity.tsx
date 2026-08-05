import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { api, type Contact } from "../api/client";
import { API_BASE } from "../config/api";
import LiquidityKpiBanner from "../components/liquidity/LiquidityKpiBanner";
import LiquidityTopology from "../components/liquidity/LiquidityTopology";
import LiquidityLane from "../components/liquidity/LiquidityLane";
import ExternalUnclassifiedSection from "../components/liquidity/ExternalUnclassifiedSection";
import { buildLiquidityPeers, computeKpis, type ChannelData } from "../components/liquidity/transform";
import type { LiquidityPeer } from "../components/liquidity/types";
import ErrorState from "../components/ErrorState";

export default function Liquidity() {
  const [peers, setPeers] = useState<LiquidityPeer[]>([]);
  const [treasuryAlias, setTreasuryAlias] = useState("Treasury");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const fetchData = useCallback(async () => {
    rowRefs.current.clear();
    try {
      const [channelsResp, contacts, nodeInfo] = await Promise.all([
        fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Promise<ChannelData[]>,
        api.getContacts().catch(() => [] as Contact[]),
        api.getNode().catch(() => null),
      ]);
      if (nodeInfo?.alias) setTreasuryAlias(nodeInfo.alias);
      setPeers(buildLiquidityPeers(channelsResp, contacts));
      setLoadError(null);
    } catch (e: any) {
      // U24 H6: the channels fetch had NO catch — an API hiccup rendered the
      // capital-monitoring page as "No active channels." Capture the failure
      // so the render can distinguish fetch-failed from genuinely-empty.
      setLoadError(e?.detail ?? e?.message ?? "fetch failed");
    }
  }, []);

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchData();
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  const handleSelect = useCallback((pubkey: string | null) => {
    setSelectedPubkey(pubkey);
    setPulseKey((k) => k + 1);
    if (pubkey) {
      const row = rowRefs.current.get(pubkey);
      row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const merchants = useMemo(() => peers.filter((p) => p.role === "merchant"), [peers]);
  const farmers = useMemo(() => peers.filter((p) => p.role === "farmer"), [peers]);
  const others = useMemo(() => peers.filter((p) => p.role === "external" || p.role === "unknown"), [peers]);
  const kpis = useMemo(() => computeKpis(peers), [peers]);

  if (loading) {
    return (
      <div className="panel fade-in">
        <div className="panel-body" style={{ padding: 32, textAlign: "center" }}>
          <div className="loading-shimmer" style={{ width: 200, height: 16, margin: "0 auto", borderRadius: 4 }} />
        </div>
      </div>
    );
  }

  // U24 H6: fetch failed and nothing loaded — error, not a fake-empty book.
  if (loadError !== null && peers.length === 0) {
    return (
      <div className="liq-page fade-in">
        <div className="liq-page-header">
          <h1 className="liq-page-title">Liquidity</h1>
        </div>
        <ErrorState
          message="Couldn't load channel liquidity."
          detail={loadError}
          onRetry={() => void handleRefresh()}
        />
      </div>
    );
  }

  return (
    <div className="liq-page fade-in">
      <div className="liq-page-header">
        <h1 className="liq-page-title">Liquidity</h1>
        {/* Keep-last-good: a failed refresh keeps the previous book on screen
           with an explicit marker instead of failing silently. */}
        {loadError !== null && peers.length > 0 && (
          <span style={{ fontSize: "0.75rem", color: "var(--amber)", fontFamily: "var(--mono)" }} role="status">
            ⚠ Refresh failed — showing previous data
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleRefresh}
          disabled={refreshing}
          style={{ fontSize: "0.75rem" }}
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <LiquidityKpiBanner kpis={kpis} />

      <LiquidityTopology
        peers={peers}
        treasuryAlias={treasuryAlias}
        selectedPubkey={selectedPubkey}
        onSelect={handleSelect}
      />

      <div className="liq-lanes">
        <LiquidityLane
          title="[ Merchants · Send Capacity ]"
          peers={merchants}
          selectedPubkey={selectedPubkey}
          pulseKey={pulseKey}
          rowRefs={rowRefs.current}
        />
        <LiquidityLane
          title="[ Farmers · Receive Capacity ]"
          peers={farmers}
          selectedPubkey={selectedPubkey}
          pulseKey={pulseKey}
          rowRefs={rowRefs.current}
        />
      </div>

      <ExternalUnclassifiedSection peers={others} />
    </div>
  );
}
