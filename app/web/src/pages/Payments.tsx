import { useEffect, useState, useCallback, useRef } from "react";
import QRCode from "qrcode";
import {
  api,
  type NetworkPayment,
  type InvoiceResult,
  type DecodedInvoice,
  type PaymentResult,
  type Contact,
  resolveContactName,
  fmtSats,
} from "../api/client";

type Tab = "request" | "pay";

export default function Payments({ title }: { title: string }) {
  const [tab, setTab] = useState<Tab>("request");
  const [payments, setPayments] = useState<NetworkPayment[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPayments = useCallback(async () => {
    try {
      const data = await api.getNetworkPayments({ limit: 50 });
      setPayments(data);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.getContacts().then(setContacts).catch(() => {}),
      api.getExchangeRate().then((r) => setRate(r.usd)).catch(() => {}),
      api.syncSettlements().catch(() => {}),
      loadPayments(),
    ]).finally(() => setLoading(false));

    const rateInterval = setInterval(() => {
      api.getExchangeRate().then((r) => setRate(r.usd)).catch(() => {});
    }, 60_000);
    return () => clearInterval(rateInterval);
  }, [loadPayments]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Request and send Lightning payments
        </p>
      </div>

      <div className="payment-tabs">
        <button
          className={`payment-tab ${tab === "request" ? "active" : ""}`}
          onClick={() => setTab("request")}
        >
          Request Payment
        </button>
        <button
          className={`payment-tab ${tab === "pay" ? "active" : ""}`}
          onClick={() => setTab("pay")}
        >
          Pay Invoice
        </button>
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-body">
          {tab === "request" ? (
            <RequestPaymentForm rate={rate} onCreated={loadPayments} />
          ) : (
            <PayInvoiceForm rate={rate} contacts={contacts} onPaid={loadPayments} />
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Payment History</span>
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          {loading ? (
            <div className="loading-shimmer" style={{ height: 120 }} />
          ) : payments.length === 0 ? (
            <div className="empty-state" style={{ padding: "40px 20px" }}>
              No payments yet. Create an invoice or pay one to get started.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Fee</th>
                    <th>Counterparty</th>
                    <th>Memo</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <PaymentRow key={p.id} payment={p} contacts={contacts} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Request Payment Form ────────────────────────────────────────────────────

function RequestPaymentForm({
  rate,
  onCreated,
}: {
  rate: number | null;
  onCreated: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const sats = Number(amount) || 0;
  const usdPreview =
    rate && sats > 0
      ? `$${((sats / 100_000_000) * rate).toFixed(2)}`
      : null;

  const handleCreate = async () => {
    if (sats <= 0) return;
    setCreating(true);
    setError("");
    try {
      const result = await api.createNetworkInvoice({
        amount_sats: sats,
        memo: memo.trim() || undefined,
      });
      setInvoice(result);
      const dataUrl = await QRCode.toDataURL(result.payment_request.toUpperCase(), {
        width: 280,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
      onCreated();
    } catch (err: any) {
      setError(err.message || "Failed to create invoice");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!invoice) return;
    navigator.clipboard.writeText(invoice.payment_request);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setInvoice(null);
    setQrDataUrl("");
    setAmount("");
    setMemo("");
    setCopied(false);
  };

  if (invoice) {
    return (
      <div className="invoice-display">
        <div style={{ textAlign: "center" }}>
          {qrDataUrl && (
            <img src={qrDataUrl} alt="Invoice QR code" className="invoice-qr" />
          )}
          <div style={{ margin: "16px 0 8px", fontSize: "1.25rem", fontWeight: 600 }}>
            {fmtSats(sats)}
            {invoice.amount_usd != null && (
              <span className="text-dim" style={{ fontSize: "0.875rem", marginLeft: 8 }}>
                (${invoice.amount_usd.toFixed(2)} USD)
              </span>
            )}
          </div>
          {memo && (
            <div className="text-dim" style={{ fontSize: "0.875rem", marginBottom: 12 }}>
              {memo}
            </div>
          )}
        </div>
        <div className="bolt11-text">{invoice.payment_request}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleCopy} style={{ flex: 1 }}>
            {copied ? "Copied!" : "Copy Invoice"}
          </button>
          <button className="btn btn-outline" onClick={handleReset}>
            New Invoice
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="form-label">Amount (sats)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input
          type="number"
          className="form-input"
          placeholder="e.g. 10000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={1}
          style={{ flex: 1 }}
        />
        {usdPreview && (
          <span className="text-dim" style={{ fontSize: "0.875rem", whiteSpace: "nowrap" }}>
            {usdPreview}
          </span>
        )}
      </div>

      <label className="form-label">Memo (optional)</label>
      <input
        type="text"
        className="form-input"
        placeholder="What's this payment for?"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        maxLength={200}
        style={{ marginBottom: 16 }}
      />

      {error && (
        <div className="alert warning" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleCreate}
        disabled={sats <= 0 || creating}
      >
        {creating ? "Creating..." : "Create Invoice"}
      </button>
    </div>
  );
}

// ─── Pay Invoice Form ────────────────────────────────────────────────────────

function PayInvoiceForm({
  rate,
  contacts,
  onPaid,
}: {
  rate: number | null;
  contacts: Contact[];
  onPaid: () => void;
}) {
  const [bolt11, setBolt11] = useState("");
  const [decoded, setDecoded] = useState<DecodedInvoice | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const trimmed = bolt11.trim();
    if (!trimmed || trimmed.length < 20) {
      setDecoded(null);
      setError("");
      return;
    }
    setDecoding(true);
    setError("");

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const d = await api.decodeInvoice(trimmed);
        setDecoded(d);
      } catch (err: any) {
        setDecoded(null);
        setError(err.message || "Invalid invoice");
      } finally {
        setDecoding(false);
      }
    }, 300);
  }, [bolt11]);

  const handlePay = async () => {
    if (!decoded) return;
    setPaying(true);
    setError("");
    setResult(null);
    try {
      const res = await api.payNetworkInvoice(bolt11.trim());
      setResult(res);
      if (res.ok) onPaid();
    } catch (err: any) {
      setError(err.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  };

  const handleReset = () => {
    setBolt11("");
    setDecoded(null);
    setResult(null);
    setError("");
  };

  if (result) {
    return (
      <div className={`payment-result ${result.ok ? "success" : "failed"}`}>
        <div style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: 8 }}>
          {result.ok ? "Payment Sent!" : "Payment Failed"}
        </div>
        {result.ok ? (
          <>
            <div>
              <strong>Amount:</strong> {fmtSats(result.amount_sats)}
              {result.amount_usd != null && (
                <span className="text-dim"> (${result.amount_usd.toFixed(2)})</span>
              )}
            </div>
            <div>
              <strong>Fee:</strong> {fmtSats(result.fee_sats)}
            </div>
            <div>
              <strong>To:</strong> {resolveContactName(result.destination, contacts)}
            </div>
            {result.memo && (
              <div>
                <strong>Memo:</strong> {result.memo}
              </div>
            )}
            <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 8, wordBreak: "break-all" }}>
              Hash: {result.payment_hash}
            </div>
          </>
        ) : (
          <div className="text-dim">{result.error}</div>
        )}
        <button className="btn btn-outline" onClick={handleReset} style={{ marginTop: 16 }}>
          {result.ok ? "New Payment" : "Try Again"}
        </button>
      </div>
    );
  }

  const usdPreview =
    rate && decoded
      ? `$${((decoded.tokens / 100_000_000) * rate).toFixed(2)}`
      : null;

  return (
    <div>
      <label className="form-label">Paste BOLT11 Invoice</label>
      <textarea
        className="form-input"
        rows={4}
        placeholder="lnbc..."
        value={bolt11}
        onChange={(e) => setBolt11(e.target.value)}
        style={{ fontFamily: "var(--mono)", fontSize: "0.8rem", resize: "vertical", marginBottom: 12 }}
      />

      {decoding && <div className="text-dim" style={{ marginBottom: 12 }}>Decoding...</div>}

      {decoded && (
        <div className="payment-preview">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Amount</span>
            <span style={{ fontWeight: 600 }}>
              {fmtSats(decoded.tokens)}
              {usdPreview && <span className="text-dim" style={{ marginLeft: 6 }}>{usdPreview}</span>}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>To</span>
            <span className="td-mono" style={{ fontSize: "0.8rem" }}>
              {resolveContactName(decoded.destination, contacts)}
            </span>
          </div>
          {decoded.description && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span>Memo</span>
              <span>{decoded.description}</span>
            </div>
          )}
          {decoded.expires_at && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Expires</span>
              <span className="text-dim">{new Date(decoded.expires_at).toLocaleString()}</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="alert warning" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handlePay}
        disabled={!decoded || paying}
      >
        {paying ? "Paying..." : "Confirm & Pay"}
      </button>
    </div>
  );
}

// ─── Payment Row ─────────────────────────────────────────────────────────────

function PaymentRow({ payment: p, contacts }: { payment: NetworkPayment; contacts: Contact[] }) {
  const dirBadge =
    p.direction === "send"
      ? { label: "Sent", cls: "badge-red" }
      : { label: "Received", cls: "badge-green" };

  const statusBadge: Record<string, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "badge-amber" },
    succeeded: { label: "Success", cls: "badge-green" },
    failed: { label: "Failed", cls: "badge-red" },
    expired: { label: "Expired", cls: "badge-muted" },
  };
  const sBadge = statusBadge[p.status] || { label: p.status, cls: "badge-muted" };

  return (
    <tr>
      <td><span className={dirBadge.cls}>{dirBadge.label}</span></td>
      <td><span className={sBadge.cls}>{sBadge.label}</span></td>
      <td className="td-num">
        {fmtSats(p.amount_sats)}
        {p.amount_usd != null && (
          <div className="text-dim" style={{ fontSize: "0.75rem" }}>
            ${p.amount_usd.toFixed(2)}
          </div>
        )}
      </td>
      <td className="td-num">{p.fee_sats > 0 ? fmtSats(p.fee_sats) : "\u2014"}</td>
      <td className="td-mono" style={{ fontSize: "0.8rem" }}>
        {p.counterparty_pubkey
          ? resolveContactName(p.counterparty_pubkey, contacts)
          : "\u2014"}
      </td>
      <td>{p.memo || "\u2014"}</td>
      <td className="text-dim" style={{ whiteSpace: "nowrap" }}>
        {new Date(p.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}
