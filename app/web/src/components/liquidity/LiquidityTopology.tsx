import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peers: LiquidityPeer[];
  treasuryAlias: string;
  selectedPubkey: string | null;
  onSelect: (pubkey: string | null) => void;
};

const W = 800;
const H = 220;
const HUB_R = 22;
const NODE_R = 10;
const ORBIT_R = 75;

export default function LiquidityTopology({ peers, treasuryAlias, selectedPubkey, onSelect }: Props) {
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);

  useEffect(() => {
    if (focusedIdx >= peers.length) {
      setFocusedIdx(peers.length === 0 ? -1 : 0);
    }
  }, [peers.length, focusedIdx]);

  const hoverTimeoutRef = useRef<number | null>(null);

  const handleHoverSelect = useCallback((pubkey: string) => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = window.setTimeout(() => {
      onSelect(pubkey);
      hoverTimeoutRef.current = null;
    }, 80);
  }, [onSelect]);

  const handleClickSelect = useCallback((pubkey: string) => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    onSelect(pubkey);
  }, [onSelect]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) {
        window.clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const positioned = useMemo(() => {
    const cx = W / 2;
    const cy = H / 2;
    const maxCap = Math.max(...peers.map((p) => p.capacity), 1);
    return peers.map((peer, i) => {
      const angle = (i / Math.max(peers.length, 1)) * 2 * Math.PI - Math.PI / 2;
      const x = cx + Math.cos(angle) * ORBIT_R;
      const y = cy + Math.sin(angle) * ORBIT_R;
      const lineWidth = Math.max(1, (peer.capacity / maxCap) * 4);
      return { peer, x, y, cx, cy, lineWidth };
    });
  }, [peers]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (hoverTimeoutRef.current !== null) {
        window.clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      if (peers.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = (focusedIdx + 1 + peers.length) % peers.length;
        setFocusedIdx(next);
        onSelect(peers[next].pubkey);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (focusedIdx - 1 + peers.length) % peers.length;
        setFocusedIdx(next);
        onSelect(peers[next].pubkey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setFocusedIdx(-1);
        onSelect(null);
      }
    },
    [focusedIdx, peers, onSelect],
  );

  if (peers.length === 0) {
    return (
      <div className="liq-topology panel ops fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        </div>
        <div className="empty-state" style={{ padding: 16 }}>No active channels.</div>
      </div>
    );
  }

  return (
    <div className="liq-topology panel ops fade-in">
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        <span className="badge badge-muted">{peers.length} peers</span>
      </div>
      <div className="panel-body" style={{ padding: 8 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="liq-topology-svg"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          role="application"
          aria-label="Network topology — use arrow keys to navigate peers"
        >
          {/* Spoke lines */}
          {positioned.map(({ peer, x, y, cx, cy, lineWidth }) => (
            <line
              key={`line-${peer.pubkey}`}
              x1={cx} y1={cy} x2={x} y2={y}
              stroke={ROLE_COLOR[peer.role]}
              strokeWidth={lineWidth}
              strokeOpacity={selectedPubkey === peer.pubkey ? 0.8 : 0.35}
              strokeLinecap="round"
            />
          ))}

          {/* Hub */}
          {(() => {
            const cx = W / 2;
            const cy = H / 2;
            return (
              <>
                <circle cx={cx} cy={cy} r={HUB_R} fill="var(--bg-2)" stroke="var(--amber)" strokeWidth={2} />
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--amber)" fontFamily="var(--mono)">
                  {treasuryAlias.length > 10 ? treasuryAlias.slice(0, 10) : treasuryAlias}
                </text>
              </>
            );
          })()}

          {/* Peer nodes */}
          {positioned.map(({ peer, x, y }) => {
            const isSelected = selectedPubkey === peer.pubkey;
            const r = isSelected ? NODE_R + 3 : NODE_R;
            const ringColor = HEALTH_COLOR[peer.healthTier];
            const fillColor = ROLE_COLOR[peer.role];
            return (
              <g
                key={`node-${peer.pubkey}`}
                onMouseEnter={() => handleHoverSelect(peer.pubkey)}
                onClick={() => handleClickSelect(peer.pubkey)}
                style={{ cursor: "pointer" }}
                aria-label={`${peer.name}, ${formatSatsShort(peer.capacity)} capacity, ${
                  peer.rolePct !== null ? `${Math.round(peer.rolePct * 100)}% ${peer.role === "merchant" ? "send" : "receive"} capacity` : "external"
                }, ${peer.healthTier}`}
              >
                <circle cx={x} cy={y} r={r + 3} fill="none" stroke={ringColor} strokeWidth={2} strokeOpacity={peer.healthTier === "neutral" ? 0.4 : 0.85} />
                <circle cx={x} cy={y} r={r} fill={fillColor} strokeOpacity={0} />
                <text x={x} y={y - r - 6} textAnchor="middle" fontSize={9} fill="var(--text-2)" fontFamily="var(--mono)">
                  {peer.name.length > 10 ? peer.name.slice(0, 9) + "…" : peer.name}
                </text>
                <text x={x} y={y + r + 12} textAnchor="middle" fontSize={8} fill="var(--text-3)" fontFamily="var(--mono)">
                  {formatSatsShort(peer.capacity)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
