import { useEffect, useState } from "react";
import { checkHealth } from "./api/client";
import { API_BASE } from "./config/api";

type NodeInfo = {
  alias: string;
  pubkey: string;
  block_height: number | null;
  synced_to_chain: number;
  has_treasury_channel: number;
};

type Channel = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
  private: number;
  updated_at: number;
};

function getSyncLabel(synced: boolean) {
  return synced ? "🟢 Synced" : "🔴 Out of sync";
}

function getSyncColor(synced: boolean) {
  return synced ? "#16a34a" : "#dc2626";  // green : red
}

function App() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    const fetchData = () => {
      // Check API health first
      checkHealth()
        .then(() => {
          setStatus("ok");

          // Fetch node info and channels in parallel
          return Promise.all([
            fetch(`${API_BASE}/api/node`).then(res => res.json()),
            fetch(`${API_BASE}/api/channels`).then(res => res.json())
          ]);
        })
        .then(([nodeData, channelsData]) => {
          if (nodeData) setNode(nodeData);
          if (channelsData) setChannels(channelsData);
        })
        .catch(() => setStatus("error"));
    };

    fetchData();
    const interval = setInterval(fetchData, 15000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h1>Bitcorn Lightning</h1>

      {status === "loading" && <p>Checking API…</p>}
      {status === "error" && <p>❌ API unreachable</p>}
      {status === "ok" && <p>✅ API is healthy</p>}

      {node && (
        <div
          style={{
            marginTop: 24,
            border: "1px solid #ccc",
            borderRadius: 8,
            padding: 16,
            maxWidth: 600
          }}
        >
          <h2>⚡ Node Overview</h2>

          <p><strong>Alias:</strong> {node.alias}</p>
          <p><strong>Pubkey:</strong> {node.pubkey}</p>
          <p><strong>Block Height:</strong> {node.block_height ?? "Unknown"}</p>
          <p>
            <strong>Status:</strong>{" "}
            <span style={{ color: getSyncColor(node.synced_to_chain === 1) }}>
              {getSyncLabel(node.synced_to_chain === 1)}
            </span>
          </p>
          <p>
            <strong>Treasury Connection:</strong>{" "}
            {node.has_treasury_channel ? (
              <span style={{ color: "#16a34a" }}>🟢 Connected</span>
            ) : (
              <span style={{ color: "#dc2626" }}>🔴 Not Connected</span>
            )}
          </p>
        </div>
      )}

      {channels.length > 0 && (
        <div
          style={{
            marginTop: 24,
            border: "1px solid #ccc",
            borderRadius: 8,
            padding: 16,
            maxWidth: 1200,
            overflowX: "auto"
          }}
        >
          <h2>📡 Channels</h2>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              marginTop: 12
            }}
          >
            <thead>
              <tr style={{ borderBottom: "2px solid #ccc" }}>
                <th style={{ textAlign: "left", padding: "8px 12px" }}>Channel ID</th>
                <th style={{ textAlign: "right", padding: "8px 12px" }}>Capacity</th>
                <th style={{ textAlign: "right", padding: "8px 12px" }}>Local Balance</th>
                <th style={{ textAlign: "right", padding: "8px 12px" }}>Remote Balance</th>
                <th style={{ textAlign: "center", padding: "8px 12px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr
                  key={channel.channel_id}
                  style={{ borderBottom: "1px solid #eee" }}
                >
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: "12px" }}>
                    {channel.channel_id.slice(0, 16)}...
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px" }}>
                    {channel.capacity_sat.toLocaleString()} sats
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px" }}>
                    {channel.local_balance_sat.toLocaleString()} sats
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px" }}>
                    {channel.remote_balance_sat.toLocaleString()} sats
                  </td>
                  <td style={{ textAlign: "center", padding: "8px 12px" }}>
                    {channel.active ? (
                      <span style={{ color: "#16a34a" }}>🟢 Active</span>
                    ) : (
                      <span style={{ color: "#dc2626" }}>🔴 Inactive</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default App;
