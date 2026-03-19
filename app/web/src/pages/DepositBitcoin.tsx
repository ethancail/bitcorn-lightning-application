import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { api } from "../api/client";

export default function DepositBitcoin() {
  const [address, setAddress] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .getNodeAddress()
      .then(async (data) => {
        setAddress(data.address);
        const url = await QRCode.toDataURL(`bitcoin:${data.address}`, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setQrDataUrl(url);
      })
      .catch(() => setError("Failed to generate deposit address"))
      .finally(() => setLoading(false));
  }, []);

  function handleCopy() {
    if (!address) return;
    try {
      navigator.clipboard.writeText(address).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(fallbackCopy);
    } catch {
      fallbackCopy();
    }
  }

  function fallbackCopy() {
    if (!address) return;
    const ta = document.createElement("textarea");
    ta.value = address;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleNewAddress() {
    setLoading(true);
    setError(null);
    setQrDataUrl(null);
    api
      .getNodeAddress()
      .then(async (data) => {
        setAddress(data.address);
        const url = await QRCode.toDataURL(`bitcoin:${data.address}`, {
          width: 280,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setQrDataUrl(url);
      })
      .catch(() => setError("Failed to generate deposit address"))
      .finally(() => setLoading(false));
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Deposit Bitcoin</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Send bitcoin to your node's on-chain wallet
        </p>
      </div>

      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↙</span>On-Chain Address
          </span>
          <span className="badge badge-muted">not a Lightning invoice</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "32px 24px" }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <div className="loading-shimmer" style={{ width: 280, height: 280, borderRadius: 8 }} />
              <div className="loading-shimmer" style={{ width: 320, height: 20, borderRadius: 4 }} />
            </div>
          ) : error ? (
            <div className="empty-state">{error}</div>
          ) : (
            <>
              {qrDataUrl && (
                <div style={{ background: "#ffffff", padding: 16, borderRadius: 12 }}>
                  <img src={qrDataUrl} alt="Bitcoin deposit address QR code" style={{ display: "block", width: 280, height: 280 }} />
                </div>
              )}

              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "0.8125rem",
                  color: "var(--text-2)",
                  wordBreak: "break-all",
                  textAlign: "center",
                  maxWidth: 400,
                  lineHeight: 1.6,
                }}
              >
                {address}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={handleCopy}>
                  {copied ? "Copied" : "Copy Address"}
                </button>
                <button className="btn btn-outline" onClick={handleNewAddress}>
                  New Address
                </button>
              </div>

              <p
                className="text-dim"
                style={{
                  fontSize: "0.75rem",
                  textAlign: "center",
                  maxWidth: 360,
                  lineHeight: 1.5,
                  marginTop: 4,
                }}
              >
                Send bitcoin on the Bitcoin mainnet to this address. This is an on-chain transaction — not Lightning. Funds will appear in your on-chain balance after confirmation.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
