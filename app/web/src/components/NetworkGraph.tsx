import { useEffect, useState } from "react";
import { api, type Contact, resolveContactName, truncPubkey } from "../api/client";
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
  merchant: "#f59e0b", // amber
  farmer: "#22c55e",   // green
  external: "#3b82f6", // blue
  unknown: "#6b7280",  // gray
};

const ROLE_LABELS: Record<string, string> = {
  merchant: "Merchant",
  farmer: "Farmer",
  external: "External",
  unknown: "Unclassified",
};

export default function NetworkGraph() {
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [treasuryAlias, setTreasuryAlias] = useState("Treasury");

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Promise<ChannelData[]>,
      api.getContacts().catch(() => [] as Contact[]),
      api.getNode().catch(() => null),
    ]).then(([channels, contacts, nodeInfo]) => {
      if (nodeInfo?.alias) setTreasuryAlias(nodeInfo.alias);

      // Known external pubkeys
      const externalPubkeys = new Set([
        "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
      ]);

      // Group channels by peer
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

      // Sort: external first, then merchants, then farmers, then unknown
      const order = { external: 0, merchant: 1, farmer: 2, unknown: 3 };
      nodeList.sort((a, b) => order[a.role] - order[b.role]);

      setNodes(nodeList);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        </div>
        <div className="panel-body" style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>
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

  // Layout
  const width = 700;
  const height = 460;
  const cx = width / 2;
  const cy = height / 2;
  const hubRadius = 32;
  const orbitRadius = 160;
  const nodeRadius = 22;
  const maxCapacity = Math.max(...nodes.map((n) => n.totalCapacity), 1);

  // Position nodes in a circle
  const positioned = nodes.map((node, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
    return {
      ...node,
      x: cx + Math.cos(angle) * orbitRadius,
      y: cy + Math.sin(angle) * orbitRadius,
      angle,
    };
  });

  const hovered = hoveredNode ? positioned.find((n) => n.pubkey === hoveredNode) : null;

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        <span className="badge badge-muted">{nodes.length} peers</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Legend */}
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

        {/* SVG Graph */}
        <div style={{ width: "100%", overflow: "hidden" }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width: "100%", height: "auto", maxHeight: 460 }}
          >
            {/* Channel lines */}
            {positioned.map((node) => {
              const capWidth = Math.max(2, (node.totalCapacity / maxCapacity) * 10);
              const localPct = node.totalCapacity > 0 ? node.totalLocal / node.totalCapacity : 0;
              const color = ROLE_COLORS[node.role];
              const isHovered = hoveredNode === node.pubkey;
              return (
                <g key={`line-${node.pubkey}`}>
                  {/* Background line (full capacity) */}
                  <line
                    x1={cx} y1={cy} x2={node.x} y2={node.y}
                    stroke={isHovered ? color : "var(--border)"}
                    strokeWidth={capWidth}
                    strokeOpacity={isHovered ? 0.4 : 0.3}
                    strokeLinecap="round"
                  />
                  {/* Local balance overlay (treasury side) */}
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

            {/* Hub node (treasury) */}
            <circle cx={cx} cy={cy} r={hubRadius + 4} fill="none" stroke="var(--amber)" strokeWidth={2} strokeOpacity={0.3} />
            <circle cx={cx} cy={cy} r={hubRadius} fill="var(--bg-2)" stroke="var(--amber)" strokeWidth={2} />
            <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--amber)" fontSize={10} fontWeight={700} fontFamily="var(--mono)">
              {treasuryAlias.length > 10 ? treasuryAlias.slice(0, 10) : treasuryAlias}
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill="var(--text-3)" fontSize={8} fontFamily="var(--mono)">
              Treasury
            </text>

            {/* Peer nodes */}
            {positioned.map((node) => {
              const color = ROLE_COLORS[node.role];
              const isHovered = hoveredNode === node.pubkey;
              const r = isHovered ? nodeRadius + 3 : nodeRadius;
              return (
                <g
                  key={`node-${node.pubkey}`}
                  onMouseEnter={() => setHoveredNode(node.pubkey)}
                  onMouseLeave={() => setHoveredNode(null)}
                  style={{ cursor: "pointer" }}
                >
                  {isHovered && (
                    <circle cx={node.x} cy={node.y} r={r + 4} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.3} />
                  )}
                  <circle
                    cx={node.x} cy={node.y} r={r}
                    fill="var(--bg-2)"
                    stroke={color}
                    strokeWidth={isHovered ? 2.5 : 1.5}
                  />
                  <text
                    x={node.x} y={node.y - 3}
                    textAnchor="middle" fill={color}
                    fontSize={node.name.length > 12 ? 7 : 8}
                    fontWeight={600}
                    fontFamily="var(--mono)"
                  >
                    {node.name.length > 14 ? node.name.slice(0, 12) + "…" : node.name}
                  </text>
                  <text
                    x={node.x} y={node.y + 9}
                    textAnchor="middle" fill="var(--text-3)" fontSize={7} fontFamily="var(--mono)"
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
              <span className="badge" style={{ marginLeft: 8, fontSize: "0.625rem" }} >{ROLE_LABELS[hovered.role]}</span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-2)", display: "flex", gap: 16 }}>
              <span>Capacity: {hovered.totalCapacity.toLocaleString()}</span>
              <span style={{ color: "var(--green)" }}>Local: {hovered.totalLocal.toLocaleString()}</span>
              <span style={{ color: "var(--red)" }}>Remote: {hovered.totalRemote.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
