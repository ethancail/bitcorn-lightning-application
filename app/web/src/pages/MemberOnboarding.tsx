import { useEffect, useState } from "react";
import { api, type NodeInfo } from "../api/client";
import bitcornLogo from "../assets/bitcorn-logo.svg";

const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

const STEPS = [
  "Connect your LND node to the hub using the public key above",
  "Open a Lightning channel to the hub (recommended: 500k–2M sats)",
  "Wait for the channel to confirm on-chain (≈1–3 blocks)",
  "This page will update automatically once you're active",
];

function statusInfo(s: string): { label: string; cls: string; hint: string } {
  switch (s) {
    case "unsynced":
      return {
        label: "Syncing",
        cls: "badge-muted",
        hint: "Your node is still syncing to the blockchain. Please wait.",
      };
    case "no_treasury_channel":
      return {
        label: "No Hub Channel",
        cls: "badge-amber",
        hint: "Open a channel to the hub to join the network.",
      };
    case "treasury_channel_inactive":
      return {
        label: "Channel Inactive",
        cls: "badge-amber",
        hint: "Your channel to the hub is not yet active. Make sure the channel is confirmed on-chain and both nodes are online.",
      };
    default:
      return { label: s.replace(/_/g, " "), cls: "badge-muted", hint: "" };
  }
}

export default function MemberOnboarding() {
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText(HUB_PUBKEY).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const info = node ? statusInfo(node.membership_status) : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 560, width: "100%" }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: "center" }}>
          <img
            src={bitcornLogo}
            alt="Bitcorn"
            style={{ height: 28, width: "auto", marginBottom: 16 }}
          />
          <div
            style={{
              color: "var(--text-2)",
              fontSize: "0.875rem",
              fontFamily: "var(--mono)",
              letterSpacing: "0.05em",
            }}
          >
            Connect to the hub to get started
          </div>
        </div>

        {/* Current status */}
        {info && (
          <div className="panel fade-in" style={{ marginBottom: 16 }}>
            <div className="panel-body">
              <div
                style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: info.hint ? 8 : 0 }}
              >
                <span style={{ color: "var(--text-3)", fontSize: "0.875rem" }}>Status</span>
                <span className={`badge ${info.cls}`}>{info.label}</span>
              </div>
              {info.hint && (
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-2)",
                    fontSize: "0.875rem",
                    lineHeight: 1.5,
                  }}
                >
                  {info.hint}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Hub pubkey */}
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">◈</span>Hub Public Key
            </span>
          </div>
          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <p
              style={{ margin: 0, color: "var(--text-2)", fontSize: "0.875rem", lineHeight: 1.5 }}
            >
              Open a channel to this public key to join the Bitcorn Lightning network.
            </p>
            <div
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "10px 14px",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                wordBreak: "break-all",
                color: "var(--text-1)",
                lineHeight: 1.6,
              }}
            >
              {HUB_PUBKEY}
            </div>
            <button
              className="btn btn-primary"
              onClick={handleCopy}
              style={{ alignSelf: "flex-start" }}
            >
              {copied ? "✓ Copied!" : "Copy Public Key"}
            </button>
          </div>
        </div>

        {/* Steps */}
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">▤</span>How to Join
            </span>
          </div>
          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            {STEPS.map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <span
                  style={{
                    minWidth: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: "var(--amber)",
                    color: "var(--bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    fontFamily: "var(--mono)",
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
                <span
                  style={{ color: "var(--text-2)", fontSize: "0.875rem", lineHeight: 1.5 }}
                >
                  {step}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
