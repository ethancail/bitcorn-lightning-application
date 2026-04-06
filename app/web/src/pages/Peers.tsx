import { useEffect, useState } from "react";
import { api, type LivePeer, type Contact, truncPubkey, resolveContactName } from "../api/client";

export default function Peers() {
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [nodeUri, setNodeUri] = useState<string | null>(null);
  const [nodeUriLoading, setNodeUriLoading] = useState(true);

  // Connect form
  const [uri, setUri] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  function loadPeers() {
    Promise.all([
      api.getLivePeers().catch(() => [] as LivePeer[]),
      api.getContacts().catch(() => [] as Contact[]),
    ]).then(([p, c]) => {
      setPeers(p);
      setContacts(c);
      setLoading(false);
    });
  }

  useEffect(() => {
    loadPeers();
    // Get treasury node URI for sharing
    api.getNode()
      .then((n) => { if (n.pubkey) setNodeUri(n.pubkey); })
      .catch(() => {})
      .finally(() => setNodeUriLoading(false));

    const id = setInterval(loadPeers, 30_000);
    return () => clearInterval(id);
  }, []);

  async function handleConnect() {
    const trimmed = uri.trim();
    if (!trimmed) return;
    setConnecting(true);
    setConnectError(null);
    setConnectResult(null);
    try {
      // Parse URI format (pubkey@host:port) or just accept raw
      if (trimmed.includes("@")) {
        await api.connectPeer({ uri: trimmed });
      } else {
        setConnectError("Enter a full node URI in the format: pubkey@host:port");
        setConnecting(false);
        return;
      }
      setConnectResult("Peer connected successfully");
      setUri("");
      loadPeers();
    } catch (e: any) {
      setConnectError(e.message ?? "Failed to connect");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Peers</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Manage direct peer connections to your Lightning node
        </p>
      </div>

      {/* ─── Treasury Node Info (for sharing) ─────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">↗</span>Your Node Info</span>
          <span className="badge badge-green">share this</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
            Share your node URI with new members so they can connect to you.
            They can find it in their Umbrel Lightning app under node settings.
          </div>
          {nodeUri ? (
            <div style={{
              padding: "10px 14px",
              background: "var(--bg-3)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontFamily: "var(--mono)",
              fontSize: "0.75rem",
              wordBreak: "break-all",
              color: "var(--text-2)",
              lineHeight: 1.5,
            }}>
              {nodeUri}
            </div>
          ) : nodeUriLoading ? (
            <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
          ) : (
            <div style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
              Unable to load node info. Check that LND is running.
            </div>
          )}
        </div>
      </div>

      {/* ─── Onboarding Instructions ──────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">?</span>Adding a New Member</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: "0.8125rem", color: "var(--text-2)", lineHeight: 1.6 }}>
            <div style={{ marginBottom: 12 }}>
              <strong style={{ color: "var(--text)" }}>What you need from them:</strong>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>1.</span>
                <span>Their <strong>Node URI</strong> — a string in the format <code style={{ background: "var(--bg-3)", padding: "2px 6px", borderRadius: 3, fontSize: "0.75rem" }}>pubkey@host:port</code></span>
              </div>
              <div style={{ display: "flex", gap: 8, paddingLeft: 26, fontSize: "0.75rem", color: "var(--text-3)" }}>
                Found in: Umbrel → Lightning Node → click the "..." menu → Copy Node URI
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>2.</span>
                <span>That's it — you just need their URI to connect and open a channel</span>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong style={{ color: "var(--text)" }}>What to tell them:</strong>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>1.</span>
                <span>Install the <strong>BitCorn Lightning</strong> app from the Umbrel Community Store</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>2.</span>
                <span>Open the app — it will auto-detect the treasury and show the member dashboard</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>3.</span>
                <span>If they have funds, they can open a channel from the app directly</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", fontWeight: 600, minWidth: 18 }}>4.</span>
                <span>If they don't have funds, you connect here and open a channel to them from the Channels page</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Connect to Peer ──────────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">+</span>Connect to Peer</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
            Paste their Node URI to establish a direct peer connection. Once connected, you can open a channel to them from the Channels page.
          </div>
          <input
            className="form-input"
            placeholder="pubkey@host:port"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
            onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
          />
          {connectError && (
            <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{connectError}</div>
          )}
          {connectResult && (
            <div style={{ color: "var(--green)", fontSize: "0.8125rem" }}>{connectResult}</div>
          )}
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={connecting || !uri.trim()}
            style={{ alignSelf: "flex-start" }}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>

      {/* ─── Connected Peers ──────────────────────────────────────────── */}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Connected Peers</span>
          <span className="badge badge-muted">{peers.length}</span>
        </div>
        {loading ? (
          <div className="panel-body">
            <div className="loading-shimmer" style={{ height: 60, borderRadius: 6 }} />
          </div>
        ) : peers.length === 0 ? (
          <div className="empty-state" style={{ padding: "40px 20px" }}>
            No peers connected. Add a peer above to get started.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Peer</th>
                  <th>Address</th>
                  <th>Direction</th>
                  <th style={{ textAlign: "right" }}>Ping</th>
                </tr>
              </thead>
              <tbody>
                {peers.map((p) => {
                  const name = resolveContactName(p.pubkey, contacts);
                  const isNamed = name !== truncPubkey(p.pubkey);
                  return (
                    <tr key={p.pubkey}>
                      <td>
                        <div style={{ fontWeight: isNamed ? 500 : 400 }}>
                          {isNamed ? name : truncPubkey(p.pubkey)}
                        </div>
                        {isNamed && (
                          <div style={{ fontSize: "0.6875rem", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                            {truncPubkey(p.pubkey)}
                          </div>
                        )}
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.address || "—"}
                      </td>
                      <td>
                        <span className={`badge ${p.is_inbound ? "badge-blue" : "badge-muted"}`}>
                          {p.is_inbound ? "inbound" : "outbound"}
                        </span>
                      </td>
                      <td className="td-num" style={{ fontFamily: "var(--mono)" }}>
                        {p.ping_time ? `${Math.round(p.ping_time / 1000)}ms` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
