import { useEffect, useState } from "react";
import { checkHealth } from "./api/client";
import { API_BASE } from "./api";

type NodeInfo = {
  alias: string;
  pubkey: string;
  block_height: number | null;
  synced_to_chain: number;
};

function App() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [node, setNode] = useState<NodeInfo | null>(null);

  useEffect(() => {
    // Check API health first
    checkHealth()
      .then(() => {
        setStatus("ok");

        // If healthy, fetch node info
        return fetch(`${API_BASE}/api/node`);
      })
      .then(res => res?.json())
      .then(data => {
        if (data) setNode(data);
      })
      .catch(() => setStatus("error"));
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
            <strong>Synced:</strong>{" "}
            {node.synced_to_chain ? "✅ Yes" : "❌ No"}
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
