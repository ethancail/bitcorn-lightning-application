import { useEffect, useState } from "react";
import { fetchPeerScores, PeerScore, truncPubkey, fmtSats } from "../api/client";

const REFRESH_MS = 30_000;

const panelStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
};

const headerStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  margin: "0 0 16px",
  color: "#111827",
};

const COL_HEADERS = ["Peer", "Channels", "Local", "Wtd ROI", "Uptime", "Score"];

export default function PeerScoresPanel() {
  const [data, setData] = useState<PeerScore[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const scores = await fetchPeerScores();
        if (!cancelled) {
          setData(scores);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div style={panelStyle}>
        <p style={headerStyle}>Peer Scores</p>
        <div style={{ fontSize: 14, color: "#6b7280" }}>Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={panelStyle}>
        <p style={headerStyle}>Peer Scores</p>
        <div style={{ fontSize: 14, color: "#dc2626" }}>
          Error: {error ?? "No data returned"}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div style={panelStyle}>
        <p style={headerStyle}>Peer Scores</p>
        <div style={{ fontSize: 14, color: "#6b7280" }}>No peers yet</div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <p style={headerStyle}>Peer Scores</p>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            color: "#111827",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
              {COL_HEADERS.map((col) => (
                <th
                  key={col}
                  style={{
                    padding: "6px 10px",
                    textAlign: "left",
                    fontWeight: 600,
                    fontSize: 12,
                    color: "#6b7280",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {data.map((peer, i) => {
              const isNegScore = peer.peer_score < 0;
              const rowBg = isNegScore
                ? "#fef2f2"
                : i % 2 === 0
                ? "#ffffff"
                : "#f9fafb";

              const uptimePct = (peer.uptime_ratio * 100).toFixed(0) + "%";

              return (
                <tr key={peer.peer_pubkey} style={{ backgroundColor: rowBg }}>
                  <td
                    style={{
                      padding: "7px 10px",
                      fontFamily: "monospace",
                      fontSize: 12,
                      color: "#374151",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {truncPubkey(peer.peer_pubkey)}
                  </td>

                  <td style={{ padding: "7px 10px", textAlign: "right" }}>
                    {peer.channel_count}
                  </td>

                  <td
                    style={{
                      padding: "7px 10px",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtSats(peer.total_local_sats)}
                  </td>

                  <td
                    style={{
                      padding: "7px 10px",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      color:
                        peer.weighted_roi_ppm > 0
                          ? "#16a34a"
                          : peer.weighted_roi_ppm < 0
                          ? "#dc2626"
                          : "#111827",
                    }}
                  >
                    {peer.weighted_roi_ppm.toLocaleString()} ppm
                  </td>

                  <td style={{ padding: "7px 10px", textAlign: "right" }}>
                    {uptimePct}
                  </td>

                  <td
                    style={{
                      padding: "7px 10px",
                      textAlign: "right",
                      fontWeight: 600,
                      color: isNegScore ? "#dc2626" : "#111827",
                    }}
                  >
                    {peer.peer_score.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
