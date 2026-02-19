import { useEffect, useState } from "react";
import { fetchChannelMetrics, ChannelMetric, truncPubkey } from "../api/client";

type SortDir = "asc" | "desc";
type ExtendedChannelMetric = ChannelMetric & { health_classification?: string };

function truncChannelId(id: string): string {
  if (!id || id.length <= 12) return id;
  return `${id.slice(0, 12)}\u2026`;
}

type HealthClassification =
  | "healthy"
  | "outbound_starved"
  | "weak"
  | "inbound_heavy"
  | "critical"
  | string;

function HealthBadge({ value }: { value: HealthClassification }) {
  const styles: Record<string, React.CSSProperties> = {
    healthy: { backgroundColor: "#dcfce7", color: "#166534" },
    outbound_starved: { backgroundColor: "#fee2e2", color: "#991b1b" },
    weak: { backgroundColor: "#fef3c7", color: "#92400e" },
    inbound_heavy: { backgroundColor: "#dbeafe", color: "#3b82f6" },
    critical: { backgroundColor: "#fee2e2", color: "#7f1d1d" },
  };

  const base: React.CSSProperties = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    ...(styles[value] ?? { backgroundColor: "#f3f4f6", color: "#374151" }),
  };

  return <span style={base}>{value.replace(/_/g, " ")}</span>;
}

interface Column {
  key: string;
  label: string;
  align: "left" | "right" | "center";
  render: (row: ExtendedChannelMetric) => React.ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: "channel_id",
    label: "Channel",
    align: "left",
    render: (row) => (
      <span title={row.channel_id} style={{ fontFamily: "monospace" }}>
        {truncChannelId(row.channel_id)}
      </span>
    ),
  },
  {
    key: "peer_pubkey",
    label: "Peer",
    align: "left",
    render: (row) => (
      <span title={row.peer_pubkey} style={{ fontFamily: "monospace" }}>
        {truncPubkey(row.peer_pubkey)}
      </span>
    ),
  },
  {
    key: "local_sats",
    label: "Local",
    align: "right",
    render: (row) => `${row.local_sats.toLocaleString()} sats`,
  },
  {
    key: "forwarded_fees_sats",
    label: "Fwd Fees",
    align: "right",
    render: (row) => `${row.forwarded_fees_sats.toLocaleString()} sats`,
  },
  {
    key: "rebalance_costs_sats",
    label: "Rebal Cost",
    align: "right",
    render: (row) =>
      row.rebalance_costs_sats > 0 ? (
        <span style={{ color: "#dc2626" }}>
          {`\u2212${row.rebalance_costs_sats.toLocaleString()} sats`}
        </span>
      ) : (
        `${row.rebalance_costs_sats.toLocaleString()} sats`
      ),
  },
  {
    key: "net_fees_sats",
    label: "Net Fees",
    align: "right",
    render: (row) => (
      <span
        style={{
          color:
            row.net_fees_sats > 0
              ? "#16a34a"
              : row.net_fees_sats < 0
              ? "#dc2626"
              : undefined,
        }}
      >
        {`${row.net_fees_sats.toLocaleString()} sats`}
      </span>
    ),
  },
  {
    key: "roi_ppm",
    label: "ROI",
    align: "right",
    render: (row) => (
      <span
        style={{
          color:
            row.roi_ppm > 0
              ? "#16a34a"
              : row.roi_ppm < 0
              ? "#dc2626"
              : undefined,
        }}
      >
        {`${row.roi_ppm} ppm`}
      </span>
    ),
  },
  {
    key: "health_classification",
    label: "Health",
    align: "center",
    render: (row) =>
      row.health_classification ? (
        <HealthBadge value={row.health_classification} />
      ) : (
        <span style={{ color: "#9ca3af" }}>&mdash;</span>
      ),
  },
];

function sortRows(
  rows: ExtendedChannelMetric[],
  key: string,
  dir: SortDir
): ExtendedChannelMetric[] {
  return [...rows].sort((a, b) => {
    const aVal = (a as Record<string, unknown>)[key];
    const bVal = (b as Record<string, unknown>)[key];
    let cmp: number;
    if (typeof aVal === "number" && typeof bVal === "number") {
      cmp = aVal - bVal;
    } else {
      cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

const PANEL_STYLE: React.CSSProperties = {
  width: "100%",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "16px 20px",
  backgroundColor: "#ffffff",
  boxSizing: "border-box",
  overflowX: "auto",
};

const TABLE_STYLE: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const TH_BASE: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "2px solid #e5e7eb",
  fontSize: 13,
  color: "#6b7280",
  fontWeight: 600,
  cursor: "pointer",
  userSelect: "none",
  whiteSpace: "nowrap",
};

const TD_BASE: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  borderBottom: "1px solid #f3f4f6",
};

export default function ChannelROITable() {
  const [rows, setRows] = useState<ExtendedChannelMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string>("roi_ppm");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchChannelMetrics()
      .then((data) => {
        if (!cancelled) {
          setRows(data as ExtendedChannelMetric[]);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load channel metrics"
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleHeaderClick(key: string) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = sortRows(rows, sortKey, sortDir);

  if (loading) {
    return (
      <div style={PANEL_STYLE}>
        <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>
          Loading channel metrics…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={PANEL_STYLE}>
        <p style={{ color: "#dc2626", fontSize: 14, margin: 0 }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div style={PANEL_STYLE}>
      <table style={TABLE_STYLE}>
        <thead>
          <tr>
            {COLUMNS.map((col) => {
              const isActive = col.key === sortKey;
              return (
                <th
                  key={col.key}
                  style={{ ...TH_BASE, textAlign: col.align }}
                  onClick={() => handleHeaderClick(col.key)}
                >
                  {col.label}
                  {isActive && (
                    <span style={{ marginLeft: 4, fontSize: 11 }}>
                      {sortDir === "asc" ? "\u25b2" : "\u25bc"}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                style={{ ...TD_BASE, textAlign: "center", color: "#9ca3af" }}
              >
                No channel data available.
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr
                key={row.channel_id}
                style={{
                  backgroundColor: row.roi_ppm < 0 ? "#fef2f2" : undefined,
                }}
              >
                {COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    style={{ ...TD_BASE, textAlign: col.align }}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
