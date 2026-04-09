import { useEffect, useState, useRef, useCallback } from "react";
import { api, type Contact, resolveContactName } from "../api/client";
import { API_BASE } from "../config/api";

type ChannelData = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
};

type NodeData = {
  pubkey: string;
  name: string;
  role: "merchant" | "farmer" | "external" | "unknown";
  channels: ChannelData[];
  totalCapacity: number;
  totalLocal: number;
  totalRemote: number;
};

const ROLE_COLORS: Record<string, string> = {
  merchant: "#f59e0b",
  farmer: "#22c55e",
  external: "#3b82f6",
  unknown: "#6b7280",
};

const ROLE_LABELS: Record<string, string> = {
  merchant: "Merchant",
  farmer: "Farmer",
  external: "External",
  unknown: "Unclassified",
};

// ─── Zoom / Pan state ───────────────────────────────────────────────────────

const WORLD_W = 900;
const WORLD_H = 900;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.15;

export default function NetworkGraph() {
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [treasuryAlias, setTreasuryAlias] = useState("Treasury");

  // Zoom / pan
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Promise<ChannelData[]>,
      api.getContacts().catch(() => [] as Contact[]),
      api.getNode().catch(() => null),
    ]).then(([channels, contacts, nodeInfo]) => {
      if (nodeInfo?.alias) setTreasuryAlias(nodeInfo.alias);

      const externalPubkeys = new Set([
        "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
      ]);

      const peerMap = new Map<string, ChannelData[]>();
      for (const ch of channels) {
        if (!peerMap.has(ch.peer_pubkey)) peerMap.set(ch.peer_pubkey, []);
        peerMap.get(ch.peer_pubkey)!.push(ch);
      }

      const nodeList: NodeData[] = [];
      for (const [pubkey, chs] of peerMap) {
        const contact = contacts.find((c) => c.pubkey === pubkey);
        const tags = (contact?.tags ?? []).map((t) => t.toLowerCase());
        let role: NodeData["role"] = "unknown";
        if (externalPubkeys.has(pubkey) || tags.includes("external")) role = "external";
        else if (tags.includes("merchant")) role = "merchant";
        else if (tags.includes("farmer")) role = "farmer";

        nodeList.push({
          pubkey,
          name: resolveContactName(pubkey, contacts),
          role,
          channels: chs,
          totalCapacity: chs.reduce((s, c) => s + c.capacity_sat, 0),
          totalLocal: chs.reduce((s, c) => s + c.local_balance_sat, 0),
          totalRemote: chs.reduce((s, c) => s + c.remote_balance_sat, 0),
        });
      }

      const order = { external: 0, merchant: 1, farmer: 2, unknown: 3 };
      nodeList.sort((a, b) => order[a.role] - order[b.role]);
      setNodes(nodeList);
      setLoading(false);
    });
  }, []);

  // ─── Zoom handlers ──────────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x) / zoom,
      y: dragStart.current.panY + (e.clientY - dragStart.current.y) / zoom,
    });
  }, [dragging, zoom]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        </div>
        <div className="panel-body" style={{ height: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="loading-shimmer" style={{ width: 300, height: 300, borderRadius: "50%" }} />
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        </div>
        <div className="empty-state">No active channels. Open channels to see your network.</div>
      </div>
    );
  }

  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const hubRadius = 40;
  const orbitRadius = 250;
  const nodeRadius = 30;
  const maxCapacity = Math.max(...nodes.map((n) => n.totalCapacity), 1);

  const positioned = nodes.map((node, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
    return {
      ...node,
      x: cx + Math.cos(angle) * orbitRadius,
      y: cy + Math.sin(angle) * orbitRadius,
    };
  });

  const hovered = hoveredNode ? positioned.find((n) => n.pubkey === hoveredNode) : null;

  // Compute viewBox based on zoom and pan
  const vbW = WORLD_W / zoom;
  const vbH = WORLD_H / zoom;
  const vbX = (WORLD_W - vbW) / 2 - pan.x;
  const vbY = (WORLD_H - vbH) / 2 - pan.y;

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        <span className="badge badge-muted">{nodes.length} peers</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Legend + zoom controls */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", gap: 16, fontSize: "0.75rem", color: "var(--text-3)", flexWrap: "wrap" }}>
            {Object.entries(ROLE_COLORS).map(([role, color]) => {
              const count = nodes.filter((n) => n.role === role).length;
              if (count === 0) return null;
              return (
                <span key={role} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
                  {ROLE_LABELS[role]} ({count})
                </span>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: "1rem", lineHeight: 1 }}
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}>+</button>
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)", minWidth: 36, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </span>
            <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: "1rem", lineHeight: 1 }}
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}>−</button>
            <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: "0.6875rem" }}
              onClick={resetView}>Reset</button>
          </div>
        </div>

        {/* SVG container with zoom/pan */}
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: 600,
            overflow: "hidden",
            borderRadius: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            cursor: dragging ? "grabbing" : "grab",
            userSelect: "none",
          }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <svg
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            style={{ width: "100%", height: "100%" }}
          >
            {/* Subtle grid */}
            <defs>
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="var(--border)" strokeWidth="0.5" strokeOpacity="0.3" />
              </pattern>
            </defs>
            <rect x={-500} y={-500} width={WORLD_W + 1000} height={WORLD_H + 1000} fill="url(#grid)" />

            {/* Orbit ring */}
            <circle cx={cx} cy={cy} r={orbitRadius} fill="none" stroke="var(--border)" strokeWidth={1} strokeOpacity={0.2} strokeDasharray="4 4" />

            {/* Channel lines */}
            {positioned.map((node) => {
              const capWidth = Math.max(3, (node.totalCapacity / maxCapacity) * 14);
              const localPct = node.totalCapacity > 0 ? node.totalLocal / node.totalCapacity : 0;
              const color = ROLE_COLORS[node.role];
              const isHovered = hoveredNode === node.pubkey;
              return (
                <g key={`line-${node.pubkey}`}>
                  <line
                    x1={cx} y1={cy} x2={node.x} y2={node.y}
                    stroke={isHovered ? color : "var(--border)"}
                    strokeWidth={capWidth}
                    strokeOpacity={isHovered ? 0.5 : 0.25}
                    strokeLinecap="round"
                  />
                  <line
                    x1={cx} y1={cy}
                    x2={cx + (node.x - cx) * localPct}
                    y2={cy + (node.y - cy) * localPct}
                    stroke={color}
                    strokeWidth={capWidth}
                    strokeOpacity={isHovered ? 1 : 0.7}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}

            {/* Hub node */}
            <circle cx={cx} cy={cy} r={hubRadius + 6} fill="none" stroke="var(--amber)" strokeWidth={2} strokeOpacity={0.2}>
              <animate attributeName="r" values={`${hubRadius + 4};${hubRadius + 8};${hubRadius + 4}`} dur="3s" repeatCount="indefinite" />
            </circle>
            <circle cx={cx} cy={cy} r={hubRadius} fill="var(--bg-2)" stroke="var(--amber)" strokeWidth={2.5} />
            <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--amber)" fontSize={12} fontWeight={700} fontFamily="var(--mono)">
              {treasuryAlias.length > 12 ? treasuryAlias.slice(0, 12) : treasuryAlias}
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="var(--text-3)" fontSize={9} fontFamily="var(--mono)">
              Treasury Hub
            </text>

            {/* Peer nodes */}
            {positioned.map((node) => {
              const color = ROLE_COLORS[node.role];
              const isHovered = hoveredNode === node.pubkey;
              const r = isHovered ? nodeRadius + 4 : nodeRadius;
              return (
                <g
                  key={`node-${node.pubkey}`}
                  onMouseEnter={() => setHoveredNode(node.pubkey)}
                  onMouseLeave={() => setHoveredNode(null)}
                  style={{ cursor: "pointer" }}
                >
                  {isHovered && (
                    <circle cx={node.x} cy={node.y} r={r + 5} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.3} />
                  )}
                  <circle
                    cx={node.x} cy={node.y} r={r}
                    fill="var(--bg-2)"
                    stroke={color}
                    strokeWidth={isHovered ? 3 : 2}
                  />
                  <text
                    x={node.x} y={node.y - 5}
                    textAnchor="middle" fill={color}
                    fontSize={node.name.length > 12 ? 8 : 10}
                    fontWeight={600}
                    fontFamily="var(--mono)"
                  >
                    {node.name.length > 14 ? node.name.slice(0, 12) + "…" : node.name}
                  </text>
                  <text
                    x={node.x} y={node.y + 9}
                    textAnchor="middle" fill="var(--text-3)" fontSize={8} fontFamily="var(--mono)"
                  >
                    {node.totalCapacity >= 1_000_000
                      ? `${(node.totalCapacity / 1_000_000).toFixed(1)}M`
                      : `${(node.totalCapacity / 1_000).toFixed(0)}k`}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Hover detail */}
        {hovered && (
          <div style={{
            padding: "10px 14px",
            background: "var(--bg-3)",
            border: `1px solid ${ROLE_COLORS[hovered.role]}`,
            borderRadius: 8,
            fontSize: "0.8125rem",
            display: "flex",
            gap: 20,
            flexWrap: "wrap",
            alignItems: "center",
          }}>
            <div>
              <span style={{ fontWeight: 600, color: ROLE_COLORS[hovered.role] }}>{hovered.name}</span>
              <span className="badge" style={{ marginLeft: 8, fontSize: "0.625rem" }}>{ROLE_LABELS[hovered.role]}</span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-2)", display: "flex", gap: 16 }}>
              <span>Capacity: {hovered.totalCapacity.toLocaleString()}</span>
              <span style={{ color: "var(--green)" }}>Local: {hovered.totalLocal.toLocaleString()}</span>
              <span style={{ color: "var(--red)" }}>Remote: {hovered.totalRemote.toLocaleString()}</span>
            </div>
          </div>
        )}

        <div style={{ fontSize: "0.6875rem", color: "var(--text-3)", textAlign: "center" }}>
          Scroll to zoom. Click and drag to pan.
        </div>
      </div>
    </div>
  );
}
